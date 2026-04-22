// ─── Generate Controller ───────────────────────────────────────────────────────
// POST /api/generate — streaming SSE endpoint: file text → AI → 3 question sets
// GET  /api/result/:id — retrieve a completed generation result by ID
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleGenAI }            from '@google/genai';
import { getModel }               from '../helpers/extractText.js';
import { storeResult, getResult } from '../helpers/resultStore.js';
import { parseQuestionsFromText } from '../helpers/parseQuestions.js';
import {
  getSystemInstruction,
  buildUserPrompt,
  parseGeminiJSON,
} from '../helpers/gemini.js';

const BATCH_SIZE   = 2;   // questions per Gemini call
const CONCURRENCY  = 5;   // parallel workers
const STAGGER_MS   = 800; // ms between worker starts
const MAX_ATTEMPTS = 5;
const GEMINI_TIMEOUT_MS = 180_000;
const FALLBACK_MODEL    = 'gemini-2.5-flash-lite';

// ── Core pipeline ─────────────────────────────────────────────────────────────
// Shared by the SSE route.  `send` is an SSE helper: send(type, payload).
export async function runGenerationPipeline(text, send, subjectHint = '') {
  const questions = parseQuestionsFromText(text);
  if (questions.length === 0) {
    send('error', { message: 'Could not detect any numbered questions in the text.' });
    return;
  }

  const batches = [];
  for (let i = 0; i < questions.length; i += BATCH_SIZE) {
    batches.push(questions.slice(i, i + BATCH_SIZE));
  }

  send('start', { totalQuestions: questions.length, totalBatches: batches.length, batchSize: BATCH_SIZE });

  const ai   = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const sets = [
    { variation_id: 1, title: 'Easy',   questions: [] },
    { variation_id: 2, title: 'Medium', questions: [] },
    { variation_id: 3, title: 'Hard',   questions: [] },
  ];
  let detectedSubject = subjectHint || 'Medicine';

  // qStarts[i] = 1-based question number where batch i begins
  const qStarts = batches.map((_, i) => 1 + batches.slice(0, i).reduce((s, b) => s + b.length, 0));

  // Process one batch with exponential-backoff retries
  const processBatch = async (b, batch, qStart) => {
    const batchText = batch.map((q, i) =>
      `${qStart + i}. ${q.replace(/\n{2,}/g, '\n').trim()}`
    ).join('\n\n');

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const useFallback = attempt >= 3;
      const modelName   = useFallback ? FALLBACK_MODEL : getModel();
      try {
        const timeout = new Promise((_, rej) =>
          setTimeout(() => rej(new Error('Gemini timed out after 180s')), GEMINI_TIMEOUT_MS)
        );
        const result = await Promise.race([
          ai.models.generateContent({
            model:    modelName,
            contents: [{ role: 'user', parts: [{ text: buildUserPrompt(batchText, batch.length) }] }],
            config:   { systemInstruction: getSystemInstruction(), temperature: 0.7, maxOutputTokens: 65536 },
          }),
          timeout,
        ]);
        const data   = parseGeminiJSON(result.text);
        const counts = (data?.variations || []).map(v => v.questions?.length || 0);
        if (counts.length >= 3 && counts.every(c => c >= batch.length)) return data;
        if (counts.length >= 3 && counts.every(c => c >= 1) && attempt >= 1) return data;
        throw new Error(`Truncated: variations have ${counts.join('/')} of ${batch.length}`);
      } catch (e) {
        if (attempt >= MAX_ATTEMPTS - 1) throw new Error(`Batch ${b + 1} failed: ${e.message}`);
        const is503 = e.message.includes('503') || e.message.includes('high demand');
        const wait  = is503 ? (attempt + 1) * 12_000 : (attempt + 1) * 5_000;
        send('batch_retry', {
          batch:  b + 1,
          reason: `${e.message}${useFallback ? ' (fallback)' : ''} — retrying in ${wait / 1000}s`,
        });
        await new Promise(r => setTimeout(r, wait));
      }
    }
  };

  // Concurrent worker pool
  const batchResults = new Array(batches.length);
  let nextBatch      = 0;
  let completedCount = 0;

  const runWorker = async (workerIdx) => {
    if (workerIdx > 0) await new Promise(r => setTimeout(r, workerIdx * STAGGER_MS));
    while (nextBatch < batches.length) {
      const b = nextBatch++;
      send('batch_start', {
        batch: b + 1, total: batches.length,
        qFrom: qStarts[b], qTo: qStarts[b] + batches[b].length - 1,
        pct:   Math.round((completedCount / batches.length) * 100),
      });
      try {
        const bData  = await processBatch(b, batches[b], qStarts[b]);
        batchResults[b] = bData;
        completedCount++;
        if (b === 0 && bData.metadata?.subject) detectedSubject = bData.metadata.subject;
        send('batch_data', {
          batch: b + 1, total: batches.length,
          pct:   Math.round((completedCount / batches.length) * 100),
          questionsProcessed: qStarts[b] + batches[b].length - 1,
          subject:   detectedSubject,
          questions: [0, 1, 2].map(v =>
            (bData.variations?.[v]?.questions || []).map((q, qi) => ({ ...q, q_num: qStarts[b] + qi }))
          ),
        });
      } catch (batchErr) {
        console.error(`Batch ${b + 1} permanently failed:`, batchErr.message);
        send('batch_skip', { batch: b + 1, total: batches.length, reason: batchErr.message });
        completedCount++;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, (_, i) => runWorker(i))
  );

  // Merge batches in order
  for (let b = 0; b < batches.length; b++) {
    const bd = batchResults[b];
    if (!bd) continue;
    if (b === 0 && bd.metadata?.subject) detectedSubject = bd.metadata.subject;
    for (let v = 0; v < 3; v++) {
      (bd.variations[v]?.questions || []).forEach((q, qi) =>
        sets[v].questions.push({ ...q, q_num: qStarts[b] + qi })
      );
    }
  }

  const totalQuestions = sets[0].questions.length;
  const resultId = storeResult({
    metadata:   { total_questions: totalQuestions, subject: detectedSubject },
    variations: sets,
  });
  send('complete', { id: resultId, totalQuestions, subject: detectedSubject });
}

// ── Route handlers ─────────────────────────────────────────────────────────────

// POST /api/generate — SSE stream; client receives events as generation progresses
export async function handleGenerate(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, payload) =>
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);

  // Heartbeat comment every 25s — keeps connection alive through proxies
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => clearInterval(heartbeat));

  try {
    const { text } = req.body;
    if (!text)                      return (send('error', { message: 'No text provided' }), res.end());
    if (!process.env.GEMINI_API_KEY) return (send('error', { message: 'GEMINI_API_KEY not set.' }), res.end());
    await runGenerationPipeline(text, send);
  } catch (err) {
    send('error', { message: err.message || 'Generation failed' });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

// GET /api/result/:id — fetch a stored result (stored after generation completes)
export function handleGetResult(req, res) {
  const data = getResult(req.params.id);
  if (!data) return res.status(404).json({ error: 'Result not found or expired' });
  res.json(data);
}
