require('dotenv').config();
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleGenAI }        = require('@google/genai');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf', '.doc', '.docx', '.txt'].includes(ext)) cb(null, true);
    else cb(new Error('Supported: PDF, DOC, DOCX, TXT'));
  }
});

// ─── Ingest setup ─────────────────────────────────────────────────────────────

const UPLOADS_DIR = path.join(__dirname, 'uploads', 'questions');
const DATA_DIR    = path.join(__dirname, 'data');
const TEMP_DIR    = path.join(__dirname, 'temp');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR))    fs.mkdirSync(DATA_DIR,    { recursive: true });
if (!fs.existsSync(TEMP_DIR))    fs.mkdirSync(TEMP_DIR,    { recursive: true });

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/pdfjs',   express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build')));

// Hidden page used by Puppeteer to render PDF pages via pdfjs-dist
app.get('/pdf-renderer', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'pdf-renderer.html'))
);

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) cb(null, true);
    else cb(new Error('Images only: JPG, PNG, WEBP'));
  }
});

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB — handles large scanned books
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.pdf') cb(null, true);
    else cb(new Error('PDF files only'));
  }
});

// ─── Text extraction ─────────────────────────────────────────────────────────

async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.pdf') {
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === '.doc') {
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);
    return doc.getBody();
  }

  if (ext === '.txt') {
    return buffer.toString('utf-8');
  }

  throw new Error('Unsupported file format');
}

function getModel() {
  return process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite-preview-06-17';
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const text = await extractText(req.file.buffer, req.file.originalname);

    if (!text || text.trim().length < 20) {
      return res.status(400).json({ error: 'Could not extract readable text from this file' });
    }

    res.json({
      success: true,
      text: text.trim(),
      fileName: req.file.originalname,
      charCount: text.trim().length
    });
  } catch (err) {
    console.error('Extract error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const BATCH_SIZE = 2; // 2 questions per call — halves API calls vs BATCH_SIZE=1 while staying within output limits

// ─── Result store (avoids sending huge JSON over SSE) ─────────────────────────
const resultStore = new Map();
let resultCounter = 0;
function storeResult(data) {
  const id = `r_${Date.now()}_${++resultCounter}`;
  resultStore.set(id, data);
  // Auto-clean after 2 hours
  setTimeout(() => resultStore.delete(id), 2 * 60 * 60 * 1000);
  return id;
}

// ─── Batch API Routes ─────────────────────────────────────────────────────────

// POST /api/batch-start  →  submit all prompts as one Gemini Batch job
app.post('/api/batch-start', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

    const questions = parseQuestionsFromText(text);
    if (questions.length === 0) return res.status(400).json({ error: 'No questions detected' });

    // Build one inline request per batch
    const batches = [];
    for (let i = 0; i < questions.length; i += BATCH_SIZE) {
      batches.push(questions.slice(i, i + BATCH_SIZE));
    }

    const qStarts = batches.map((_, i) => 1 + batches.slice(0, i).reduce((s, b) => s + b.length, 0));

    const inlinedRequests = batches.map((batch, b) => {
      const batchText = batch.map((q, i) => `${qStarts[b] + i}. ${q}`).join('\n\n');
      return {
        contents: [{ parts: [{ text: buildGeminiPrompt(batchText, batch.length) }], role: 'user' }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 20480 }
      };
    });

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

    const job = await ai.batches.create({
      model,
      src: inlinedRequests,
      config: { displayName: `fmge-${Date.now()}` }
    });

    // Store metadata so we can reconstruct q_nums on result fetch
    resultStore.set(`meta_${job.name}`, { totalQuestions: questions.length, qStarts, batchLengths: batches.map(b => b.length) });

    res.json({
      jobName: job.name,
      totalBatches: batches.length,
      totalQuestions: questions.length,
      model,
      state: job.state
    });

  } catch (err) {
    console.error('Batch start error:', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/batch-status  →  poll job state
app.get('/api/batch-status', async (req, res) => {
  try {
    const { jobName } = req.query;
    if (!jobName) return res.status(400).json({ error: 'jobName required' });

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const job = await ai.batches.get({ name: jobName });
    res.json({ state: job.state, name: job.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/batch-result  →  parse completed job results
app.get('/api/batch-result', async (req, res) => {
  try {
    const { jobName } = req.query;
    if (!jobName) return res.status(400).json({ error: 'jobName required' });

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const job = await ai.batches.get({ name: jobName });

    if (job.state !== 'JOB_STATE_SUCCEEDED') {
      return res.status(400).json({ error: `Job not ready: ${job.state}` });
    }

    // Get inline responses (we used inline requests so results are inline)
    const responses = job.dest?.inlinedResponses || [];
    const meta = resultStore.get(`meta_${jobName}`) || {};
    const { qStarts = [], batchLengths = [] } = meta;

    const sets = [
      { variation_id: 1, title: 'Variation 1', questions: [] },
      { variation_id: 2, title: 'Variation 2', questions: [] },
      { variation_id: 3, title: 'Variation 3', questions: [] }
    ];
    let detectedSubject = 'Medicine';

    for (let b = 0; b < responses.length; b++) {
      const item = responses[b];
      if (item.error) {
        console.warn(`Batch ${b} error:`, item.error);
        continue;
      }

      const raw = item.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      let batchData;
      try {
        batchData = parseGeminiJSON(raw);
      } catch (e) {
        console.warn(`Batch ${b} JSON parse error:`, e.message);
        continue;
      }

      if (b === 0 && batchData.metadata?.subject) {
        detectedSubject = batchData.metadata.subject;
      }

      const qStart = qStarts[b] || 1;
      for (let v = 0; v < 3; v++) {
        (batchData.variations?.[v]?.questions || []).forEach((q, qi) => {
          sets[v].questions.push({ ...q, q_num: qStart + qi });
        });
      }
    }

    const totalQuestions = sets[0].questions.length;
    const resultData = {
      metadata: { total_questions: totalQuestions, subject: detectedSubject },
      variations: sets
    };
    const resultId = storeResult(resultData);
    res.json({ resultId, totalQuestions, subject: detectedSubject });

  } catch (err) {
    console.error('Batch result error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Streaming generate (kept as fallback) ────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  // SSE headers — keep connection alive for streaming progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, payload) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  // Heartbeat — sends a comment every 25s to prevent browser/proxy from killing the connection
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);
  res.on('close', () => clearInterval(heartbeat));

  try {
    const { text } = req.body;
    if (!text) { send('error', { message: 'No text provided' }); clearInterval(heartbeat); return res.end(); }

    if (!process.env.GEMINI_API_KEY) {
      send('error', { message: 'GEMINI_API_KEY not set. Add it to your .env file.' });
      return res.end();
    }

    // ── Parse questions out of raw text ────────────────────────────────────
    const questions = parseQuestionsFromText(text);
    if (questions.length === 0) {
      send('error', { message: 'Could not detect any numbered questions in the file.' });
      return res.end();
    }

    // ── Chunk into batches of BATCH_SIZE ───────────────────────────────────
    const batches = [];
    for (let i = 0; i < questions.length; i += BATCH_SIZE) {
      batches.push(questions.slice(i, i + BATCH_SIZE));
    }

    send('start', {
      totalQuestions: questions.length,
      totalBatches: batches.length,
      batchSize: BATCH_SIZE
    });

    // Use new @google/genai SDK — supports all current models
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    // Accumulators for 3 variation sets
    const sets = [
      { variation_id: 1, title: 'Variation 1', questions: [] },
      { variation_id: 2, title: 'Variation 2', questions: [] },
      { variation_id: 3, title: 'Variation 3', questions: [] }
    ];
    let detectedSubject = 'Medicine';

    // ── Process a single batch (with retry + exponential backoff) ─────────
    const GEMINI_TIMEOUT_MS = 180000;
    const FALLBACK_MODEL = 'gemini-2.5-flash-lite';
    const MAX_ATTEMPTS = 5;

    const processBatch = async (b, batch, qStart) => {
      // Collapse internal double-newlines (paragraph-per-option format) to single newlines
      // so options sit on consecutive lines and don't visually merge with the batch separator.
      const batchText = batch.map((q, i) => {
        const flat = q.replace(/\n{2,}/g, '\n').trim();
        return `${qStart + i}. ${flat}`;
      }).join('\n\n');

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const useFallback = attempt >= 3;
        const modelName = useFallback ? FALLBACK_MODEL : getModel();

        try {
          const prompt = buildUserPrompt(batchText, batch.length);
          const timeout = new Promise((_, rej) =>
            setTimeout(() => rej(new Error('Gemini timed out after 180s')), GEMINI_TIMEOUT_MS)
          );
          const callGemini = ai.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              systemInstruction: getSystemInstruction(),
              temperature: 0.7,
              maxOutputTokens: 65536
            }
          });
          const result = await Promise.race([callGemini, timeout]);
          const raw = result.text;
          console.log(`Batch ${b+1} raw length: ${raw.length} chars`);
          const data = parseGeminiJSON(raw);
          const counts = (data?.variations || []).map(v => v.questions?.length || 0);
          const allComplete = counts.length >= 3 && counts.every(c => c >= batch.length);
          if (allComplete) return data;
          // Accept partial results on later attempts — better than skipping the whole batch
          const partialOk = counts.length >= 3 && counts.every(c => c >= 1);
          if (partialOk && attempt >= 1) {
            console.warn(`Batch ${b+1} partial (${counts.join('/')} of ${batch.length}) — accepting`);
            return data;
          }
          throw new Error(`Truncated: variations have ${counts.join('/')} questions, expected ${batch.length} each`);
        } catch (e) {
          if (attempt >= MAX_ATTEMPTS - 1) throw new Error(`Batch ${b + 1} failed: ${e.message}`);

          const is503 = e.message.includes('503') || e.message.includes('Service Unavailable') || e.message.includes('high demand');
          const wait = is503 ? (attempt + 1) * 12000 : (attempt + 1) * 5000;
          const modelNote = useFallback ? ` (using fallback model)` : '';
          send('batch_retry', { batch: b + 1, reason: `${e.message}${modelNote} — retrying in ${wait / 1000}s` });
          await new Promise(r => setTimeout(r, wait));
        }
      }
    };

    // ── Concurrent batch processing ───────────────────────────────────────
    const CONCURRENCY = 5; // more workers since each call is now 1 question (small + fast)
    const STAGGER_MS  = 800; // shorter stagger — calls are smaller
    const batchResults = new Array(batches.length);
    const qStarts = batches.map((_, i) => 1 + batches.slice(0, i).reduce((s, b) => s + b.length, 0));

    let nextBatch = 0;
    let completedCount = 0;

    const runWorker = async (workerIdx) => {
      // Stagger workers so they don't hit Gemini simultaneously
      if (workerIdx > 0) await new Promise(r => setTimeout(r, workerIdx * STAGGER_MS));

      while (nextBatch < batches.length) {
        const b = nextBatch++;
        send('batch_start', {
          batch: b + 1,
          total: batches.length,
          qFrom: qStarts[b],
          qTo: qStarts[b] + batches[b].length - 1,
          pct: Math.round((completedCount / batches.length) * 100)
        });

        let bData = null;
        try {
          bData = await processBatch(b, batches[b], qStarts[b]);
        } catch (batchErr) {
          // One batch failing must not kill the whole job — log, notify, and continue
          console.error(`Batch ${b + 1} permanently failed, skipping:`, batchErr.message);
          send('batch_skip', { batch: b + 1, total: batches.length, reason: batchErr.message });
          completedCount++;
          continue;
        }

        batchResults[b] = bData;
        completedCount++;

        // Send the actual question data so client can checkpoint it
        if (b === 0 && bData.metadata?.subject) detectedSubject = bData.metadata.subject;
        const checkpointQuestions = [
          (bData.variations?.[0]?.questions || []).map((q, qi) => ({ ...q, q_num: qStarts[b] + qi })),
          (bData.variations?.[1]?.questions || []).map((q, qi) => ({ ...q, q_num: qStarts[b] + qi })),
          (bData.variations?.[2]?.questions || []).map((q, qi) => ({ ...q, q_num: qStarts[b] + qi }))
        ];
        send('batch_data', {
          batch: b + 1,
          total: batches.length,
          pct: Math.round((completedCount / batches.length) * 100),
          questionsProcessed: qStarts[b] + batches[b].length - 1,
          subject: detectedSubject,
          questions: checkpointQuestions  // [set1, set2, set3]
        });
      }
    };

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, batches.length) },
      (_, i) => runWorker(i)
    );
    await Promise.all(workers);

    // ── Merge results in order (skip any batches that permanently failed) ──
    for (let b = 0; b < batches.length; b++) {
      const batchData = batchResults[b];
      if (!batchData) continue;
      if (b === 0 && batchData.metadata?.subject) {
        detectedSubject = batchData.metadata.subject;
      }
      for (let v = 0; v < 3; v++) {
        (batchData.variations[v]?.questions || []).forEach((q, qi) => {
          sets[v].questions.push({ ...q, q_num: qStarts[b] + qi });
        });
      }
    }

    // ── Store result + send lightweight complete event ─────────────────────
    const totalQuestions = sets[0].questions.length;
    const resultData = {
      metadata: { total_questions: totalQuestions, subject: detectedSubject },
      variations: sets
    };
    const resultId = storeResult(resultData);
    send('complete', {
      id: resultId,
      totalQuestions,
      subject: detectedSubject
    });

  } catch (err) {
    console.error('Generate error:', err.message);
    send('error', { message: err.message || 'Generation failed' });
  } finally {
    clearInterval(heartbeat);
  }

  res.end();
});

app.get('/api/result/:id', (req, res) => {
  const data = resultStore.get(req.params.id);
  if (!data) return res.status(404).json({ error: 'Result not found or expired' });
  res.json(data);
});

app.post('/api/pdf', async (req, res) => {
  try {
    const { variation, metadata, pdfSubject } = req.body;
    if (!variation) return res.status(400).json({ error: 'No variation data' });

    const html = buildPDFHtml(variation, metadata, pdfSubject);

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(120000);
    page.setDefaultTimeout(120000);

    // 'load' waits for DOM + scripts but not CDN idle — much faster than networkidle0
    await page.setContent(html, { waitUntil: 'load', timeout: 120000 });

    // Brief settle for layout
    await new Promise(r => setTimeout(r, 800));

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', right: '14mm', bottom: '18mm', left: '14mm' }
    });

    await browser.close();

    const subject  = (pdfSubject?.trim() || metadata?.subject || 'FMGE').substring(0, 30);
    const setNum   = variation.variation_id || variation.title.replace(/\D/g, '') || '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${subject} SET - ${setNum}.pdf"`);
    res.send(pdf);

  } catch (err) {
    console.error('PDF error:', err.message);
    res.status(500).json({ error: err.message || 'PDF generation failed' });
  }
});


// ─── Helpers ─────────────────────────────────────────────────────────────────

// Split raw text into individual question strings
function parseQuestionsFromText(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ── Strategy A: paragraph-per-option, 4+ newlines between questions ──────────
  // Radio-style: each option is its own paragraph (\n\n), questions separated by \n{4,}
  const paraBlocks = normalized.split(/\n{4,}/)
    .map(b => b.trim())
    .filter(b => b.split(/\n{2,}/).length >= 4 && b.length > 15);

  // ── Strategy B: compact-line style ──────────────────────────────────────────
  // Surgery-style: question + options on consecutive \n-separated lines,
  // blank lines (\n{2,}) separate questions.
  const compactBlocks = normalized.split(/\n{2,}/)
    .map(b => b.trim())
    .filter(b => b.split('\n').length >= 3 && b.length > 15);

  // ── Strategy C: numbered-question patterns ───────────────────────────────────
  // For files where every question starts with "1." or "1)" on its own line.
  const numCandidates = [
    { pattern: /\n(?=\d{1,3}\.\s)/,           numRe: /^\d{1,3}\.\s/ },
    { pattern: /\n\s*(?=\d{1,3}\.\s)/,        numRe: /^\d{1,3}\.\s/ },
    { pattern: /\n\s*(?=\d{1,3}\)\s)/,        numRe: /^\d{1,3}\)\s/ },
    { pattern: /(?<!\d)(?=\d{1,3}\.\s[A-Z])/, numRe: /^\d{1,3}\.\s/ },
  ];
  let numBest = [];
  for (const { pattern, numRe } of numCandidates) {
    const parts = normalized.split(pattern);
    const qs = parts.map(p => p.trim()).filter(p => numRe.test(p) && p.length > 10);
    if (qs.length > numBest.length) numBest = qs;
  }

  // ── Strategy D: content-aware grouping for unnumbered clinical vignette MCQs ──
  // Psy-style: everything separated by \n\n (no distinction between option gap
  // and question gap). Detects a new question by content heuristics.
  const isNewQuestion = p => {
    if (p.length < 20) return false;
    const n = p.replace(/\s+/g, ' ');           // normalise whitespace (fixes double-space OCR)
    const stripped = n.replace(/^[\d\W]+/, ''); // strip leading OCR digits e.g. "8Inability"
    const tp = stripped.length > 5 ? stripped : n;
    return (
      /\b\d+[\s-]?year[\s-]?old\b/i.test(n) ||
      /\b\d+\s*y[\s/]o\b/i.test(n) ||
      /\b(presents?|presented|brought|admitted|referred|complains?|reports?)\b/i.test(n) ||
      /^(which|what|how|where|identify|select|name|choose)\b/i.test(tp) ||
      /\bof the following\b/i.test(n) ||
      /\ball (are|of the following|except)\b/i.test(n) ||
      /\b(true|false) (about|statement|regarding)\b/i.test(n) ||
      /\b(most common|drug of choice|investigation of choice)\b/i.test(n) ||
      /\b(not true|not seen|not a feature|not associated|except)\b/i.test(n) ||
      (n.endsWith(':') && n.length >= 35) ||
      (n.endsWith('?') && n.length >= 25) ||
      // Incomplete-statement MCQ stems ending with a dangling medical phrase
      /\b(lesions? of|associated with|characterized by|defined as|known as|defect of|disturbance of|disturbance in|used for|seen in|found in|occurs in|indicated in|caused by)\s*$/i.test(n) ||
      /^the following\b/i.test(n) ||
      (/^(the |a |an )/i.test(n) && n.length > 60)
    );
  };

  const rawParas = normalized.split(/\n{2,}/)
    .map(p => p.replace(/\n/g, ' ').trim())
    .filter(p => p.length > 5);

  const contentGroups = [];
  let cur = [];
  for (const p of rawParas) {
    if (cur.length === 0) {
      cur.push(p);
    } else if (isNewQuestion(p) && cur.length >= 3) {
      contentGroups.push(cur.join('\n'));
      cur = [p];
    } else {
      cur.push(p);
    }
  }
  if (cur.length >= 2) contentGroups.push(cur.join('\n'));

  // ── Pick the strategy that found the most questions ──────────────────────────
  let best = [];
  if (paraBlocks.length    > best.length) best = paraBlocks;
  if (compactBlocks.length > best.length) best = compactBlocks;
  if (numBest.length       > best.length) best = numBest;
  if (contentGroups.length > best.length) best = contentGroups;

  if (best.length < 3) return [normalized];

  return best.map(q => q.replace(/^\d{1,3}[.)]\s*/, '').trim());
}

// Static instructions — set as systemInstruction so Gemini 2.5+ implicit caching kicks in.
// This block is identical across all batches, so tokens are cached after the first call.
function getSystemInstruction() {
  return `You are an expert FMGE exam writer with 20 years of experience writing genuine medical licensing exam questions.

═══ QUESTION WRITING RULES ═══
Generate 3 variations of each source question. All 3 test the SAME concept with the SAME correct answer — only the clinical presentation differs.

MAKING QUESTIONS FEEL GENUINE (critical):
• Vary patient demographics naturally: mix ages (18-75), both sexes, different socioeconomic hints ("farmer", "office worker", "student")
• Use realistic clinical detail: specific vitals, lab values with units, duration of symptoms, relevant negatives
• Vary question styles: "most likely diagnosis", "next best step", "drug of choice", "mechanism of action", "which finding confirms"
• Avoid AI patterns: never start every question with "A X-year-old presents with" — use "A patient", "A woman", "Following a road accident", "On examination", "Laboratory results show"
• Distractors must be genuinely tempting — same drug class, same symptom overlap, common exam traps
• OPTIONS: shuffle A/B/C/D each variation, replace ≥2 distractor texts, correct_answer letter must match new position
• q_num = same across all 3 sets

═══ EXPLANATION RULES ═══
overview (1 sentence): The single fact that makes the answer obvious. Start with the diagnosis/drug/mechanism directly. No "This question tests..."

detailed (2 sentences MAX):
  Sentence 1 — WHY correct answer is right (specific mechanism/value/guideline).
  Sentence 2 — WHY top 2 distractors are wrong ("while X lacks... and Y causes...").

key_points (exactly 3 bullets): One exam-ready fact each. Specific numbers, stages, drugs. Format: "Fact — clinical implication"

references (1 only): Standard textbook, edition, chapter name AND page numbers. Format: "Book Title, Xth Ed, Ch XX (Title), pp. XXX-XXX"
Example: "Harrison's Principles of Internal Medicine, 21st Ed, Ch 270 (Ischemic Heart Disease), pp. 1893-1910"

═══ TABLE RULE (mandatory, every question) ═══
Every question MUST have "table" filled in — never null. "flowchart" must always be null.
Use table for: drug comparisons, disease differentials, staging, side-by-side features, classification, lab values.
table format: {"caption":"Title","headers":["Feature","Option A","Option B"],"rows":[["row","val","val"]]}

═══ IMAGE PROMPT RULES ═══
question_image_prompt: TARGET 8-10% of questions per batch (roughly 1 in 10). You MUST reach this minimum — do not go below it. Set for questions where a diagram or image meaningfully helps the student understand or visualise the answer, including: histology slides, ECG/X-ray/imaging findings, anatomical diagrams, microbiology stain/colony appearance, biochemical pathway diagrams, embryology structures, surgical anatomy landmarks. Do NOT set for pure recall, clinical vignettes with no visual component, or drug mechanism questions. Format: plain string, 2 sentences — exact visual description + style (labeled medical diagram, white background).
explanation_image_prompt: Always null. Do not generate this field.

═══ OUTPUT ═══
Raw JSON only. No markdown. No code fences. Start with { end with }.

{"metadata":{"total_questions":0,"subject":"<detected subject>"},"variations":[{"variation_id":1,"title":"Variation 1","questions":[{"q_num":1,"question":"Following a blood transfusion, a 32-year-old develops sudden breathlessness and hypoxia within 2 hours. Chest X-ray shows bilateral infiltrates. Which of the following is the most likely diagnosis?","question_image_prompt":null,"options":{"A":"Transfusion-associated circulatory overload","B":"Transfusion-related acute lung injury","C":"Anaphylactic transfusion reaction","D":"Delayed hemolytic reaction"},"correct_answer":"B","explanation":{"overview":"TRALI presents within 6 hours of transfusion with non-cardiogenic pulmonary edema — bilateral infiltrates without fluid overload.","detailed":"TRALI is caused by donor anti-HLA antibodies activating recipient neutrophils causing capillary leak, while TACO presents with hypertension and cardiomegaly and anaphylaxis causes urticaria and bronchospasm without bilateral infiltrates.","table":{"caption":"Transfusion Reactions Comparison","headers":["Feature","TRALI","TACO","Anaphylaxis"],"rows":[["Onset","Within 6h","During/after","Immediate"],["Mechanism","Anti-HLA Ab","Fluid overload","IgE-mediated"],["BP","Low/normal","High","Low"],["CXR","Bilateral infiltrates","Cardiomegaly","Normal"],["Treatment","Supportive O2","Diuretics","Epinephrine"]]},"flowchart":null,"explanation_image_prompt":null,"key_points":["TRALI — onset within 6h, bilateral infiltrates, non-cardiogenic, anti-HLA antibodies from donor","TACO — hypertension + cardiomegaly on CXR, responds to diuretics","Anaphylaxis — IgE-mediated, urticaria + bronchospasm, treat with epinephrine"],"references":["Harrison's Principles of Internal Medicine, 21st Ed, Ch 113 (Transfusion Biology and Therapy), pp. 812-818"]}}]},{"variation_id":2,"title":"Variation 2","questions":[]},{"variation_id":3,"title":"Variation 3","questions":[]}]}`;
}

// Variable part sent as user message — only the questions change per batch
function buildUserPrompt(batchText, qCount) {
  return `Generate 3 variations of the following ${qCount} source questions.

SOURCE QUESTIONS:
${batchText}

IMPORTANT: Your entire response must be a single valid JSON object. Start with { and end with }. No preamble, no explanation, no markdown, no code fences — pure JSON only.`;
}

// Kept for batch-start route (uses @google/genai which takes a single contents array)
function buildGeminiPrompt(batchText, qCount) {
  return `${getSystemInstruction().replace('total_questions":0', `total_questions":${qCount}`)}\n\nSOURCE QUESTIONS:\n${batchText}`;
}

// ─── Mermaid sanitizer ────────────────────────────────────────────────────────
// Reserved Mermaid keywords that cannot be used as node IDs
const MERMAID_RESERVED = new Set(['end','start','class','style','graph','subgraph','direction','click','call','href','linkStyle','classDef','default']);

function sanitizeFlowchart(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // Convert escaped \n to real newlines, strip code fences
  let code = raw
    .replace(/```(?:mermaid)?/gi, '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, ' ')
    .trim();

  // Must start with graph TD
  if (!/^graph\s+(TD|LR|TB|RL|BT)/i.test(code)) {
    const match = code.match(/graph\s+(TD|LR|TB|RL|BT)/i);
    if (match) {
      code = code.slice(code.indexOf(match[0]));
    } else {
      code = 'graph TD\n' + code;
    }
  }

  // Aggressively clean label text — strip everything that can break mermaid parser
  const cleanLabel = txt => txt
    .replace(/["""'''`]/g, ' ')        // all quote types
    .replace(/[<>]/g, ' ')             // HTML brackets
    .replace(/[\[\]{}()]/g, ' ')       // nested shape chars
    .replace(/:/g, ' ')                // colons break edge syntax
    .replace(/;/g, ' ')                // semicolons
    .replace(/[\/\\]/g, ' ')           // slashes
    .replace(/[&%@!?=+*#$^~]/g, ' ')  // all special chars
    .replace(/\|/g, ' ')               // pipe chars
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 35);                 // keep labels short

  // Remap ALL multi-char node IDs to safe single letters
  const idRemap = {};
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let idSeq = 0;
  const safeId = id => {
    const key = id.trim();
    // Single uppercase letter — already safe
    if (/^[A-Z]$/.test(key)) return key;
    // Reserved keyword or multi-char — remap
    if (!idRemap[key]) {
      idRemap[key] = alphabet[idSeq % 26] + (idSeq >= 26 ? Math.floor(idSeq/26) : '');
      idSeq++;
    }
    return idRemap[key];
  };

  const lines = code.split('\n').map((line, lineIdx) => {
    const trimmed = line.trim();

    // Keep graph declaration line as-is
    if (lineIdx === 0 && /^graph\s/i.test(trimmed)) return line;

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('%%')) return '';

    // Sanitize edge labels |text| first (before other transforms)
    line = line.replace(/\|\s*([^|]*?)\s*\|/g, (_, t) => `|${cleanLabel(t)}|`);

    // Sanitize labels inside shapes
    line = line
      .replace(/\[([^\]]*)\]/g,  (_, t) => `[${cleanLabel(t)}]`)
      .replace(/\{([^}]*)\}/g,   (_, t) => `{${cleanLabel(t)}}`)
      .replace(/\(([^)]*)\)/g,   (_, t) => `(${cleanLabel(t)})`);

    // Remap node IDs on LEFT side of arrows
    line = line.replace(/^(\s*)(\w+)(\s*(?:-->|---|==>|-\.-?>?))/g,
      (m, sp, id, rest) => `${sp}${safeId(id)}${rest}`
    );

    // Remap node IDs on RIGHT side of arrows (after --> or |label|)
    line = line.replace(/(-->|\|[^|]*\|)\s*(\w+)/g,
      (m, arrow, id) => `${arrow} ${safeId(id)}`
    );

    // Remap standalone node definitions: ID[...] or ID{...} or ID(...)
    line = line.replace(/^(\s*)(\w+)(\s*[\[{(])/g,
      (m, sp, id, rest) => `${sp}${safeId(id)}${rest}`
    );

    return line;
  });

  const result = lines.filter(l => l !== '').join('\n');

  // Basic validity — must have at least one arrow and at least 2 lines
  const hasArrow = result.includes('-->') || result.includes('==>') || result.includes('---');
  if (!hasArrow || result.split('\n').length < 2) return null;

  return result;
}

// Pre-processing: fix the most common LLM JSON mistakes before parsing
function sanitizeJSON(text) {
  // 1. Replace smart / curly quotes with straight quotes
  text = text
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2039\u203A]/g, "'");

  // 2. Fix trailing commas before } or ]  e.g.  {"a":1,}
  text = text.replace(/,\s*([}\]])/g, '$1');

  // 3. Fix unescaped double-quotes inside JSON string values.
  //    Strategy: walk char-by-char; when inside a string, any " not preceded
  //    by \ and not closing the string gets escaped.
  let result = '';
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) { result += c; escaped = false; continue; }
    if (c === '\\') { result += c; escaped = true; continue; }
    if (c === '"') {
      if (!inStr) {
        inStr = true; result += c;
      } else {
        // Peek ahead: if next non-space char is :, , } ] it's a closing quote
        let j = i + 1;
        while (j < text.length && text[j] === ' ') j++;
        const next = text[j];
        if (!next || ':,}]'.includes(next) || next === '\n' || next === '\r') {
          inStr = false; result += c;
        } else {
          // Mid-string unescaped quote — escape it
          result += '\\"';
        }
      }
      continue;
    }
    result += c;
  }
  return result;
}

function parseGeminiJSON(raw) {
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');

  const end = cleaned.lastIndexOf('}');
  if (end > start) {
    // Try 1: direct parse
    try { return JSON.parse(cleaned.substring(start, end + 1)); } catch (_) {}
    // Try 2: sanitize then parse
    try { return JSON.parse(sanitizeJSON(cleaned.substring(start, end + 1))); } catch (_) {}
  }

  // ── Truncation recovery ─────────────────────────────────────────────────────
  // Walk the raw text tracking bracket depth to find every position where the
  // top-level object closes cleanly, then try the longest valid slice.
  const text = cleaned.substring(start);
  let depth = 0, inStr = false, esc = false;
  let lastDepthZero = -1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (esc)          { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true;  continue; }
    if (c === '"')    { inStr = !inStr; continue; }
    if (inStr)        continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) lastDepthZero = i;
    }
  }

  // Try the longest well-closed slice we found
  if (lastDepthZero > 0) {
    try {
      return JSON.parse(text.substring(0, lastDepthZero + 1));
    } catch (_) {}
  }

  // Last resort: progressively strip trailing characters until we get valid JSON
  for (let trim = text.length - 1; trim > text.length * 0.5; trim--) {
    if (text[trim] !== '}' && text[trim] !== ']') continue;
    try {
      return JSON.parse(text.substring(0, trim + 1));
    } catch (_) {}
  }

  throw new Error('Could not parse or recover JSON from response');
}

// ─── PDF HTML Template ────────────────────────────────────────────────────────

function imagePromptBox(prompt, label) {
  if (!prompt) return '';
  // Gemini sometimes returns image prompts as objects {text:"..."} instead of plain strings
  let text;
  if (typeof prompt === 'string') {
    text = prompt;
  } else if (typeof prompt === 'object') {
    text = prompt.text || prompt.description || prompt.prompt ||
           Object.values(prompt).find(v => typeof v === 'string') || '';
  } else {
    text = String(prompt);
  }
  if (!text) return '';
  return `
  <div class="img-prompt-box">
    <div class="img-prompt-label">🖼️ ${label}</div>
    <div class="img-prompt-text">${text}</div>
    <div class="img-prompt-hint">📋 Copy this prompt → paste into ChatGPT / DALL-E / Gemini / Bing Image Creator to generate the diagram</div>
  </div>`;
}

function tableHTML(tbl) {
  if (!tbl || !tbl.headers || !tbl.rows) return '';
  const caption = tbl.caption ? `<caption>${tbl.caption}</caption>` : '';
  const headers = tbl.headers.map(h => `<th>${h}</th>`).join('');
  const rows    = tbl.rows.map(row =>
    `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`
  ).join('');
  return `
  <div class="exp-block">
    <h4>Comparison Table</h4>
    <table class="exp-table">${caption}<thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

function buildPDFHtml(variation, metadata, pdfSubject) {
  const subject = (pdfSubject && pdfSubject.trim()) || metadata?.subject || 'FMGE';

  const questionsHTML = variation.questions.map((q, idx) => {
    const exp  = q.explanation || {};
    const opts = q.options || {};
    const correct = q.correct_answer;

    const optionsHTML = Object.entries(opts).map(([k, v]) => `
      <div class="option ${k === correct ? 'correct' : ''}">
        <span class="opt-key">${k}</span>
        <span class="opt-text">${v || ''}</span>
        ${k === correct ? '<span class="tick">✓ Correct Answer</span>' : ''}
      </div>`).join('');

    const toArr = v => Array.isArray(v) ? v : (v ? [v] : []);
    const keyPtsHTML = toArr(exp.key_points).map(p => `<li>${p}</li>`).join('');
    const refsHTML   = toArr(exp.references).map(r => `<li>${r}</li>`).join('');

    const flowchartHTML = ''; // flowcharts removed — tables only

    const expImgPrompt = ''; // explanation_image_prompt disabled in prompt — always omitted

    return `
    <div class="q-card">
      <div class="q-head">
        <span class="q-badge">Q${idx + 1}</span>
        <p class="q-text">${q.question || ''}</p>
      </div>

      ${imagePromptBox(q.question_image_prompt, 'Image Prompt for this Question')}

      <div class="q-opts">${optionsHTML}</div>

      <div class="q-exp">
        <div class="exp-block">
          <h4>Clinical Overview</h4>
          <p>${exp.overview || ''}</p>
        </div>
        <div class="exp-block">
          <h4>Detailed Explanation</h4>
          <p>${exp.detailed || ''}</p>
        </div>
        ${expImgPrompt}
        ${tableHTML(exp.table)}
        ${flowchartHTML}

        <div class="exp-block key-pts">
          <h4>⭐ High-Yield Exam Points</h4>
          <ul>${keyPtsHTML}</ul>
        </div>
        <div class="exp-block refs">
          <h4>📚 References</h4>
          <ol>${refsHTML}</ol>
        </div>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>FMGE ${variation.title}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#fff;color:#1a1a2e;font-size:10.5pt;line-height:1.65}

  /* Inline page header */
  .pg-head{
    background:linear-gradient(135deg,#0f3460 0%,#16213e 100%);
    color:#fff;padding:18px 22px;border-radius:8px;margin-bottom:18px;
    display:flex;align-items:center;justify-content:space-between;gap:16px
  }
  .pg-head-left h1{font-size:13pt;font-weight:800;letter-spacing:-0.3px;margin-bottom:2px}
  .pg-head-left p{font-size:8.5pt;color:#adb5bd}
  .pg-head-right{text-align:right}
  .pg-head-right .pill{
    display:inline-block;background:#48cae4;color:#0f3460;
    padding:4px 14px;border-radius:20px;font-size:9pt;font-weight:700
  }
  .pg-head-right .meta{font-size:8.5pt;color:#adb5bd;margin-top:4px}

  /* Question card */
  .q-card{border:1px solid #dee2e6;border-radius:8px;overflow:visible;margin-bottom:22px}

  .q-head{background:#f1f3f9;padding:14px 18px;border-bottom:3px solid #0f3460;display:flex;align-items:flex-start;gap:12px}
  .q-badge{background:#0f3460;color:#fff;padding:4px 10px;border-radius:4px;font-weight:700;font-size:10pt;white-space:nowrap;flex-shrink:0}
  .q-text{font-size:11pt;font-weight:600;color:#1a1a2e;flex:1}

  /* Options */
  .q-opts{padding:10px 18px 6px;background:#fff}
  .option{display:flex;align-items:center;padding:7px 12px;margin:5px 0;border-radius:5px;border:1px solid #e9ecef;font-size:10.5pt}
  .option.correct{background:#d4edda;border:2px solid #28a745}
  .opt-key{font-weight:700;color:#0f3460;min-width:22px}
  .option.correct .opt-key{color:#155724}
  .tick{margin-left:auto;background:#28a745;color:#fff;padding:2px 8px;border-radius:4px;font-size:8.5pt;font-weight:700;white-space:nowrap}

  /* Explanation */
  .q-exp{background:#fafbfc;border-top:1px solid #dee2e6;padding:18px}
  .exp-block{margin-bottom:16px}
  .exp-block h4{font-size:9.5pt;font-weight:700;color:#0f3460;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:7px;padding-bottom:4px;border-bottom:1px solid #e9ecef}
  .exp-block p{font-size:10pt;color:#2d3436;line-height:1.7}
  .exp-block ul{margin-left:18px;font-size:10pt;color:#2d3436}
  .exp-block li{margin-bottom:4px}
  .key-pts li::marker{color:#0f3460;font-weight:700}

  /* Refs */
  .refs ol{margin-left:18px}
  .refs li{font-size:9.5pt;color:#333;padding:3px 0;border-bottom:1px dotted #dee2e6;line-height:1.5}

  /* Flowchart */
  .flowchart-wrap{background:#f9fbff;border:1.5px solid #c8d8f0;border-radius:8px;padding:12px 14px 10px;overflow:hidden}
  .mermaid{text-align:center;margin-top:8px;overflow:hidden;width:100%;max-height:265px}
  .mermaid svg{max-width:100%!important;display:block;margin:0 auto}

  /* Comparison table */
  .exp-table{width:100%;border-collapse:collapse;font-size:9.5pt;margin-top:8px}
  .exp-table caption{font-size:9pt;color:#555;font-style:italic;margin-bottom:6px;text-align:left}
  .exp-table th{background:#0f3460;color:#fff;padding:7px 10px;text-align:left;font-weight:600}
  .exp-table td{padding:6px 10px;border:1px solid #dee2e6;vertical-align:top}
  .exp-table tr:nth-child(even) td{background:#f8f9fa}

  /* Image prompt box */
  .img-prompt-box{background:#fffbeb;border:1.5px dashed #f59e0b;border-radius:8px;padding:12px 16px;margin:10px 18px}
  .img-prompt-label{font-size:9pt;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px}
  .img-prompt-text{font-size:10pt;color:#451a03;line-height:1.6;font-style:italic}
  .img-prompt-hint{font-size:8.5pt;color:#b45309;margin-top:6px;padding-top:6px;border-top:1px dotted #f59e0b}
</style>
</head>
<body>

<div class="pg-head">
  <div class="pg-head-left">
    <h1>A.J Medical Academy &nbsp;·&nbsp; FMGE Question Bank</h1>
    <p>Subject: ${subject} &nbsp;|&nbsp; ${variation.title}</p>
  </div>
  <div class="pg-head-right">
    <span class="pill">${variation.questions.length} Questions</span>
    <div class="meta">${subject}</div>
  </div>
</div>

${questionsHTML}

<script>
  const MAX_CHART_H = 260; // max flowchart height in px — keeps it on one page

  function fixSVG(svg) {
    if (!svg) return;
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.display = 'block';
    svg.style.margin = '0 auto';
    svg.style.maxWidth = '100%';
    svg.style.width = '100%';
    svg.style.height = 'auto';

    // Scale down tall charts so they never span multiple pages
    const h = svg.getBoundingClientRect().height;
    if (h > MAX_CHART_H) {
      const scale = MAX_CHART_H / h;
      svg.style.transform = 'scale(' + scale + ')';
      svg.style.transformOrigin = 'top center';
      svg.style.height = h + 'px';
      svg.style.marginBottom = '-' + (h - MAX_CHART_H) + 'px';
    }
  }

  function cleanErrors() {
    document.querySelectorAll('.mermaid').forEach(el => {
      const hasBomb   = !!el.querySelector('.error-icon, [class*="error"]');
      const hasErrTxt = el.textContent.includes('Syntax error') || el.textContent.includes('Parse error') || el.textContent.includes('mermaid version');
      const hasSVG    = !!el.querySelector('svg');

      if (hasBomb || hasErrTxt || !hasSVG) {
        // Hide entire flowchart section — no blank space left behind
        const wrap = el.closest('.flowchart-wrap');
        if (wrap) wrap.style.display = 'none';
        return;
      }
      fixSVG(el.querySelector('svg'));
    });
    window.__mermaidDone = true;
  }

  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    securityLevel: 'loose',
    flowchart: {
      curve: 'linear',
      useMaxWidth: true,
      htmlLabels: false,
      rankSpacing: 35,
      nodeSpacing: 25,
      diagramPadding: 10
    },
    suppressErrorRendering: true
  });

  mermaid.run({ querySelector: '.mermaid', suppressErrors: true })
    .then(cleanErrors)
    .catch(() => { cleanErrors(); });

  setTimeout(cleanErrors, 3000);
</script>
</body>
</html>`;
}

// ─── Ingest Routes ───────────────────────────────────────────────────────────

const INGEST_PROMPT_TWO = `You are given TWO scanned pages from an FMGE exam preparation book.
IMAGE 1: Question page — numbered questions with stem text and answer options a, b, c, d.
IMAGE 2: Answer/Explanation page — answer keys with brief clinical explanations.

Extract ALL questions from IMAGE 1 and match each with its answer from IMAGE 2 by question number.

Return ONLY valid JSON, no markdown, no code fences, start with { end with }:
{
  "questions": [
    {
      "q_num": 3,
      "stem": "exact full question text as printed",
      "option_a": "exact option a text",
      "option_b": "exact option b text",
      "option_c": "exact option c text",
      "option_d": "exact option d text",
      "correct_option": "b",
      "correct_answer_text": "exact text of the correct answer",
      "explanation": ["<bullet 1 from book>", "<bullet 2 from book>"],
      "source": "Most Recent Question July 2023",
      "has_image": false,
      "image_description": null,
      "subject_hint": "anatomy"
    }
  ],
  "page_notes": "e.g. 6 questions found, 6 answers matched"
}

Rules:
- Copy stems and options EXACTLY as printed — do not paraphrase
- explanation: array of bullet points copied EXACTLY from IMAGE 2 for that question. Extract only the bullet points that are visibly printed — do NOT add, invent, or infer extra points. If the book shows 2 bullets, return 2. If it shows 4, return 4. Never exceed what is printed.
- If answer not found on IMAGE 2, set correct_option: null
- If question references a diagram or image, set has_image: true and describe it in image_description
- subject_hint must be one of: anatomy, physiology, biochemistry, pathology, pharmacology, medicine, surgery, obgy, paediatrics, psychiatry, ophthalmology, ent, dermatology, radiology, community_medicine
- Match answers by question number only — never guess`;

const INGEST_PROMPT_ONE = `You are given a scanned page from an FMGE exam preparation book containing questions only.

Extract ALL questions visible on this page.

Return ONLY valid JSON, no markdown, no code fences:
{
  "questions": [
    {
      "q_num": 1,
      "stem": "exact full question text",
      "option_a": "option a",
      "option_b": "option b",
      "option_c": "option c",
      "option_d": "option d",
      "correct_option": null,
      "correct_answer_text": null,
      "explanation": [],
      "source": "source tag if visible else null",
      "has_image": false,
      "image_description": null,
      "subject_hint": "anatomy"
    }
  ],
  "page_notes": "question-only page — answers not available"
}

Copy text EXACTLY as printed. Set correct_option null since this is question-only page.`;

// POST /api/ingest/extract — 2 images → structured questions via Gemini Vision
app.post('/api/ingest/extract', imageUpload.fields([
  { name: 'questionPage', maxCount: 1 },
  { name: 'answerPage',   maxCount: 1 }
]), async (req, res) => {
  try {
    if (!req.files?.questionPage) {
      return res.status(400).json({ error: 'Question page image is required' });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
    }

    const qImg = req.files.questionPage[0];
    const aImg = req.files.answerPage?.[0];

    const parts = [
      { inlineData: { data: qImg.buffer.toString('base64'), mimeType: qImg.mimetype } }
    ];

    if (aImg) {
      parts.push({ inlineData: { data: aImg.buffer.toString('base64'), mimeType: aImg.mimetype } });
      parts.push({ text: INGEST_PROMPT_TWO });
    } else {
      parts.push({ text: INGEST_PROMPT_ONE });
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const result = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      contents: [{ role: 'user', parts }],
      config: { temperature: 0.1, maxOutputTokens: 8192 }
    });

    const raw = result.text;
    let data;
    try {
      data = parseGeminiJSON(raw);
    } catch (e) {
      return res.status(500).json({ error: 'Gemini returned unparseable response', raw: raw.slice(0, 600) });
    }

    if (!Array.isArray(data.questions)) {
      return res.status(500).json({ error: 'Unexpected Gemini response structure', raw: raw.slice(0, 600) });
    }

    res.json({
      success: true,
      questions: data.questions,
      page_notes: data.page_notes || '',
      total: data.questions.length
    });

  } catch (err) {
    console.error('Ingest extract error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ingest/save — save approved questions to data/questions.json
app.post('/api/ingest/save', (req, res) => {
  try {
    const { questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'No questions provided' });
    }

    const dbPath = path.join(DATA_DIR, 'questions.json');
    let existing = [];
    if (fs.existsSync(dbPath)) {
      try { existing = JSON.parse(fs.readFileSync(dbPath, 'utf-8')); } catch {}
    }

    // Dedup: compare first 80 chars of stem
    const existingStems = new Set(existing.map(q => (q.stem || '').slice(0, 80).toLowerCase().trim()));
    const saved = [];
    const dupes = [];

    for (const q of questions) {
      const key = (q.stem || '').slice(0, 80).toLowerCase().trim();
      if (existingStems.has(key)) {
        dupes.push(q.q_num);
      } else {
        const record = {
          id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          q_num:               q.q_num,
          stem:                q.stem,
          option_a:            q.option_a,
          option_b:            q.option_b,
          option_c:            q.option_c,
          option_d:            q.option_d,
          correct_option:      q.correct_option,
          correct_answer_text: q.correct_answer_text,
          explanation:         Array.isArray(q.explanation) ? q.explanation : (q.explanation ? [q.explanation] : []),
          source:              q.source,
          subject:             q.subject || q.subject_hint || 'unknown',
          topic:               q.topic   || null,
          difficulty:          q.difficulty || 'medium',
          has_image:           q.has_image || false,
          image_url:           q.image_url || null,
          image_description:   q.image_description || null,
          tags:                q.tags || [],
          created_at:          new Date().toISOString()
        };
        saved.push(record);
        existingStems.add(key);
      }
    }

    const updated = [...existing, ...saved];
    fs.writeFileSync(dbPath, JSON.stringify(updated, null, 2));

    res.json({
      success: true,
      saved: saved.length,
      duplicates: dupes.length,
      duplicate_nums: dupes,
      total_in_db: updated.length
    });

  } catch (err) {
    console.error('Ingest save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ingest/upload-image — store a question diagram image to disk
app.post('/api/ingest/upload-image', imageUpload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const { questionId } = req.body;
    const ext      = path.extname(req.file.originalname).toLowerCase() || '.png';
    const filename = `${questionId || `img_${Date.now()}`}${ext}`;
    const filepath = path.join(UPLOADS_DIR, filename);

    fs.writeFileSync(filepath, req.file.buffer);

    res.json({
      success: true,
      url: `/uploads/questions/${filename}`,
      filename
    });

  } catch (err) {
    console.error('Image upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ingest/stats — question bank summary for admin dashboard
app.get('/api/ingest/stats', (req, res) => {
  try {
    const dbPath = path.join(DATA_DIR, 'questions.json');
    if (!fs.existsSync(dbPath)) return res.json({ total: 0, subjects: {}, has_image: 0 });

    const qs = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    const subjects = {};
    let has_image = 0;
    qs.forEach(q => {
      const s = q.subject || 'unknown';
      subjects[s] = (subjects[s] || 0) + 1;
      if (q.has_image) has_image++;
    });

    res.json({ total: qs.length, subjects, has_image });
  } catch (err) {
    res.json({ total: 0, subjects: {}, has_image: 0 });
  }
});

// ─── PYQ Extractor (text-based PDFs, zero Gemini) ────────────────────────────

const SUBJECT_KEYWORDS = {
  anatomy:           ['nerve','artery','vein','bone','muscle','ligament','foramen','fascia','lymph','embryo','histology','thorax','abdomen','pelvis','vertebra','cranial'],
  physiology:        ['jvp','ecg','action potential','cardiac output','renal','glomerular','spirometry','reflex','hormone','receptor','compliance','tidal volume'],
  biochemistry:      ['enzyme','cofactor','coenzyme','substrate','atp','nadh','krebs','glycolysis','fatty acid','amino acid','dna','rna','nucleotide','metabolism','cholesterol'],
  pathology:         ['neoplasm','carcinoma','metastasis','inflammation','necrosis','infarct','granuloma','fibrosis','biopsy','histopathology','mutation','tumour'],
  pharmacology:      ['drug','dose','receptor','agonist','antagonist','antibiotic','inhibitor','penicillin','amoxicillin','warfarin','heparin','beta blocker','ace inhibitor'],
  medicine:          ['hypertension','diabetes','infarction','heart failure','stroke','seizure','pneumonia','tuberculosis','hepatitis','cirrhosis','renal failure'],
  surgery:           ['appendicitis','hernia','cholecystitis','bowel obstruction','peritonitis','fracture','dislocation','tourniquet','anastomosis','laparotomy'],
  obgy:              ['obstetric','gynaecology','pregnancy','labour','placenta','uterus','ovary','menstrual','preeclampsia','abortion','contraception','amenorrhea'],
  paediatrics:       ['child','infant','neonate','growth','vaccination','milestone','kwashiorkor','marasmus','juvenile','congenital','paediatric'],
  psychiatry:        ['schizophrenia','depression','bipolar','anxiety','phobia','psychosis','delusion','hallucination','ocd','ptsd','autism','dementia','mania'],
  ophthalmology:     ['eye','retina','cornea','lens','glaucoma','cataract','optic','visual','conjunctiva','pupil','refraction','fundus'],
  ent:               ['ear','nose','throat','tympanic','cochlea','larynx','tonsil','sinusitis','epistaxis','hearing','vertigo','otitis'],
  dermatology:       ['skin','rash','eczema','psoriasis','acne','melanoma','pemphigus','dermatitis','pruritus','alopecia','vitiligo','lesion'],
  radiology:         ['x-ray','ct scan','mri','ultrasound','contrast','radiograph','opacity','consolidation','shadow','imaging'],
  community_medicine:['epidemiology','prevalence','incidence','vaccination','immunization','sanitation','nutrition','public health','survey','mortality','morbidity','water','sewage','cohort','case control'],
  forensic_medicine: ['postmortem','autopsy','rigor','livor','putrefaction','wound','medicolegal','poison','forensic','death','hanging','drowning']
};

function detectSubject(stem) {
  const lower = stem.toLowerCase();
  let best = null, bestScore = 0;
  for (const [subj, kws] of Object.entries(SUBJECT_KEYWORDS)) {
    const score = kws.filter(k => lower.includes(k)).length;
    if (score > bestScore) { bestScore = score; best = subj; }
  }
  return bestScore > 0 ? best : null;
}

function cleanOption(raw) {
  return (raw || '')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}\d+\s*$/, '')   // trailing page numbers
    .replace(/\s+/g, ' ')
    .trim();
}

function joinExplanationLines(raw) {
  // Stop at the first table-like section or "Incorrect Options" section
  // These signal we've left the real bullet-point explanation
  const stopPattern = /\n(?:Incorrect\s+Options?|Correct\s+Options?|Feature\s+Details?|ECG\s+Irregularly|Atrial\s+fibrillation\s*:|Mitral\s+stenosis\s*:|JVP\s+Waveform|JVP\s+finding)/i;
  const stopMatch = raw.search(stopPattern);
  const cleanRaw = stopMatch > 0 ? raw.slice(0, stopMatch) : raw;

  const lines = cleanRaw.split('\n').map(l => l.trim()).filter(Boolean);
  const points = [];

  for (const line of lines) {
    // Skip pure page numbers (lone digits) or very short lines
    if (/^\d+$/.test(line) || line.length < 10) continue;

    if (/^[•\-\*]/.test(line)) {
      // Real bullet — start a new point
      points.push(line.replace(/^[•\-\*]\s*/, '').trim());
    } else if (points.length > 0) {
      // Continuation of previous bullet (wrapped line)
      const last = points[points.length - 1];
      if (/[.!?]$/.test(last)) {
        // Previous point ended — this is a new prose point only if long enough
        if (line.length > 30) points.push(line);
      } else {
        points[points.length - 1] = last + ' ' + line;
      }
    } else if (line.length > 30) {
      // First prose line before any bullet (intro sentence)
      points.push(line);
    }
  }

  return points
    .map(p => p.trim())
    .filter(p =>
      p.length > 15 &&
      !/^(Incorrect|Correct\s*(Option|Answer)|Reference|Learning\s*Outcome|Feature|Cause|Management|ECG|Complications|Treatment|Pathophysiology|Clinical\s*features|Auscultation)/i.test(p)
    );
}

// Phrases that indicate the question requires a visual (image/diagram)
const IMAGE_HINT_PATTERN = /\b(shown?\s+below|shown?\s+above|as\s+shown|given\s+below|given\s+above|see\s+(?:the\s+)?(?:figure|image|diagram|picture|photo|graph|chart|x.?ray|ecg|eeg|mri|ct)|(?:ecg|eeg|x.?ray|mri|ct\s+scan|photograph|picture|image|diagram|figure|graph)\s+(?:is\s+)?shown|refer\s+to\s+(?:the\s+)?(?:figure|image|diagram)|following\s+(?:image|figure|diagram|picture|x.?ray|ecg|mri|ct)|the\s+(?:image|figure|diagram|picture|x.?ray|ecg|mri|ct)\s+(?:below|above))\b/i;

function parsePYQBlock(raw) {
  const stem = (raw.match(/^([\s\S]*?)Option\s*1\s*:/i)?.[1] || '')
    .replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const option_a = cleanOption(raw.match(/Option\s*1\s*:\s*\n([\s\S]*?)Option\s*2\s*:/i)?.[1]);
  const option_b = cleanOption(raw.match(/Option\s*2\s*:\s*\n([\s\S]*?)Option\s*3\s*:/i)?.[1]);
  const option_c = cleanOption(raw.match(/Option\s*3\s*:\s*\n([\s\S]*?)Option\s*4\s*:/i)?.[1]);
  const option_d = cleanOption(raw.match(/Option\s*4\s*:\s*\n([\s\S]*?)Correct\s*option/i)?.[1]);
  const correctNum = raw.match(/Correct\s*option\s*:\s*(\d)/i)?.[1];
  const correctMap = { '1': 'a', '2': 'b', '3': 'c', '4': 'd' };
  const correct_option = correctMap[correctNum] || null;
  const explRaw = raw.match(/Explanation\s*:?\s*\n([\s\S]*?)(?:Reference\s*:|Learning\s*Outcome\s*:|$)/i)?.[1] || '';
  const explanation = joinExplanationLines(explRaw).slice(0, 5);

  // Detect if this question needs an image that pdf-parse cannot extract
  const has_image    = IMAGE_HINT_PATTERN.test(stem);
  const image_needed = has_image; // flag for UI to show warning

  return { stem, option_a, option_b, option_c, option_d, correct_option, explanation, has_image, image_needed };
}

function parsePYQText(text, source) {
  const blocks = text.split(/\n\d+\.\s*Question\s*:?\s*\n/i).slice(1);
  return blocks
    .map(raw => parsePYQBlock(raw))
    .filter(q => q.stem.length > 10 && q.option_a && q.correct_option)
    .map(q => ({
      ...q,
      source:        source || 'FMGE PYQ',
      subject:       detectSubject(q.stem),
      subject_hint:  detectSubject(q.stem),
      has_image:     q.has_image || false,
      image_needed:  q.image_needed || false,
      image_url:     null,
      tags:          q.has_image ? ['pyq', 'image-needed'] : ['pyq'],
      difficulty:    'medium'
    }));
}

// POST /api/pyq/extract — parse one or more PYQ PDFs, return questions (no Gemini)
app.post('/api/pyq/extract', pdfUpload.fields([
  { name: 'pdfs', maxCount: 20 }
]), async (req, res) => {
  try {
    const files = req.files?.pdfs || [];
    if (!files.length) return res.status(400).json({ error: 'Upload at least one PDF' });

    const allQuestions = [];
    const fileResults  = [];

    for (const file of files) {
      try {
        const data   = await pdfParse(file.buffer);
        const source = file.originalname.replace(/\.pdf$/i, '');
        const qs     = parsePYQText(data.text, source);
        allQuestions.push(...qs);
        fileResults.push({ file: file.originalname, extracted: qs.length });
      } catch (err) {
        fileResults.push({ file: file.originalname, extracted: 0, error: err.message });
      }
    }

    res.json({ success: true, total: allQuestions.length, files: fileResults, questions: allQuestions });
  } catch (err) {
    console.error('PYQ extract error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Batch Routes ────────────────────────────────────────────────────────────

// Helper: run one Gemini extraction call given image buffers
async function extractFromImages(ai, qImgBuffer, qMime, aImgBuffer, aMime) {
  const parts = [{ inlineData: { data: qImgBuffer.toString('base64'), mimeType: qMime } }];
  if (aImgBuffer) {
    parts.push({ inlineData: { data: aImgBuffer.toString('base64'), mimeType: aMime } });
    parts.push({ text: INGEST_PROMPT_TWO });
  } else {
    parts.push({ text: INGEST_PROMPT_ONE });
  }
  const result = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: [{ role: 'user', parts }],
    config: { temperature: 0.1, maxOutputTokens: 8192 }
  });
  const data = parseGeminiJSON(result.text);
  if (!Array.isArray(data.questions)) throw new Error('Invalid Gemini response structure');
  return data;
}

// POST /api/batch/process-pairs — multiple screenshot pairs via SSE
app.post('/api/batch/process-pairs', imageUpload.fields([
  { name: 'qPages', maxCount: 100 },
  { name: 'aPages', maxCount: 100 }
]), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, payload) => res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  const hb = setInterval(() => res.write(': ping\n\n'), 20000);
  res.on('close', () => clearInterval(hb));

  try {
    const qPages = req.files?.qPages || [];
    const aPages = req.files?.aPages || [];
    if (!qPages.length) { send('error', { message: 'No question page images uploaded' }); return res.end(); }
    if (!process.env.GEMINI_API_KEY) { send('error', { message: 'GEMINI_API_KEY not set' }); return res.end(); }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const total = qPages.length;
    send('start', { total });

    for (let i = 0; i < total; i++) {
      send('pair_start', { pair: i + 1, total, name: qPages[i].originalname });
      try {
        const aImg = aPages[i];
        const data = await extractFromImages(
          ai,
          qPages[i].buffer, qPages[i].mimetype,
          aImg?.buffer || null, aImg?.mimetype || null
        );
        send('pair_done', { pair: i + 1, total, questions: data.questions, page_notes: data.page_notes || '' });
      } catch (err) {
        send('pair_error', { pair: i + 1, total, error: err.message });
      }
      if (i < total - 1) await new Promise(r => setTimeout(r, 800)); // rate limit
    }
    send('complete', { total });
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    clearInterval(hb);
    res.end();
  }
});

// Shared helper — render all pages of a PDF buffer → array of PNG buffers
async function renderPdfPages(browser, pdfBuffer, scale) {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/pdf-renderer`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForFunction(() => window.__renderReady === true, { timeout: 30000 });
  const base64 = pdfBuffer.toString('base64');
  const pageCount = await page.evaluate(b64 => window.__loadPdf(b64), base64);
  const pages = [];
  for (let p = 1; p <= pageCount; p++) {
    const dataUrl = await page.evaluate(
      (pNum, sc) => window.__renderPage(pNum, sc), p, scale
    );
    pages.push(Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  await page.close();
  return { pages, pageCount };
}

// POST /api/batch/render-pdf — render PDF pages via Puppeteer+pdfjs (SSE)
app.post('/api/batch/render-pdf', pdfUpload.single('pdf'), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, payload) => res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  const hb = setInterval(() => res.write(': ping\n\n'), 20000);
  res.on('close', () => clearInterval(hb));

  let browser;
  try {
    if (!req.file) { send('error', { message: 'No PDF uploaded' }); return res.end(); }

    const startPage = Math.max(1, parseInt(req.body.startPage) || 1);
    const endPage   = parseInt(req.body.endPage) || null;

    const jobId  = `job_${Date.now()}`;
    const jobDir = path.join(TEMP_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}/pdf-renderer`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction(() => window.__renderReady === true, { timeout: 30000 });

    const base64pdf = req.file.buffer.toString('base64');
    const pageCount = await page.evaluate(b64 => window.__loadPdf(b64), base64pdf);

    const last  = Math.min(endPage || pageCount, pageCount);
    const first = Math.min(startPage, last);
    const total = last - first + 1;

    send('ready', { jobId, pageCount, first, last, total });

    for (let p = first; p <= last; p++) {
      // thumbnail at 0.35 scale (for grid display)
      const thumbUrl = await page.evaluate(
        (pNum, sc) => window.__renderPage(pNum, sc), p, 0.35
      );
      // full-res at 1.8 scale (for Gemini extraction) — saved to disk
      const fullUrl  = await page.evaluate(
        (pNum, sc) => window.__renderPage(pNum, sc), p, 1.8
      );
      const fullBuf = Buffer.from(fullUrl.split(',')[1], 'base64');
      fs.writeFileSync(path.join(jobDir, `p${String(p).padStart(4, '0')}.png`), fullBuf);

      send('page', { jobId, pageNum: p, total: pageCount, pct: Math.round(((p - first + 1) / total) * 100), thumb: thumbUrl });
    }

    fs.writeFileSync(path.join(jobDir, 'meta.json'),
      JSON.stringify({ pageCount, first, last, createdAt: new Date().toISOString() }));

    send('complete', { jobId, pagesRendered: total });
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
    clearInterval(hb);
    res.end();
  }
});

// POST /api/batch/process-from-pdf — process rendered PDF page pairs (SSE)
app.post('/api/batch/process-from-pdf', express.json(), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, payload) => res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  const hb = setInterval(() => res.write(': ping\n\n'), 20000);
  res.on('close', () => clearInterval(hb));

  try {
    const { jobId, pairs } = req.body;
    if (!jobId || !Array.isArray(pairs) || !pairs.length) {
      send('error', { message: 'jobId and pairs[] required' }); return res.end();
    }
    if (!process.env.GEMINI_API_KEY) { send('error', { message: 'GEMINI_API_KEY not set' }); return res.end(); }

    const ai    = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const total = pairs.length;
    send('start', { total });

    for (let i = 0; i < total; i++) {
      const { qPage, aPage } = pairs[i];
      send('pair_start', { pair: i + 1, total, qPage, aPage });

      try {
        const qPath = path.join(TEMP_DIR, jobId, `p${String(qPage).padStart(4, '0')}.png`);
        const aPath = aPage ? path.join(TEMP_DIR, jobId, `p${String(aPage).padStart(4, '0')}.png`) : null;
        if (!fs.existsSync(qPath)) throw new Error(`Page ${qPage} image not found — render the PDF first`);

        const qBuf = fs.readFileSync(qPath);
        const aBuf = (aPath && fs.existsSync(aPath)) ? fs.readFileSync(aPath) : null;
        const data = await extractFromImages(ai, qBuf, 'image/png', aBuf, 'image/png');
        send('pair_done', { pair: i + 1, total, qPage, aPage, questions: data.questions });
      } catch (err) {
        send('pair_error', { pair: i + 1, total, qPage, aPage, error: err.message });
      }
      if (i < total - 1) await new Promise(r => setTimeout(r, 800));
    }
    send('complete', { total });
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    clearInterval(hb);
    res.end();
  }
});

// POST /api/batch/process-dual-pdf — two PDFs → render → pair → extract (SSE)
app.post('/api/batch/process-dual-pdf', pdfUpload.fields([
  { name: 'questionsPdf', maxCount: 1 },
  { name: 'answersPdf',   maxCount: 1 }
]), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, payload) => res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  const hb = setInterval(() => res.write(': ping\n\n'), 20000);
  res.on('close', () => clearInterval(hb));

  let browser;
  try {
    const qPdf = req.files?.questionsPdf?.[0];
    const aPdf = req.files?.answersPdf?.[0];

    if (!qPdf) { send('error', { message: 'Questions PDF is required' }); return res.end(); }
    if (!process.env.GEMINI_API_KEY) { send('error', { message: 'GEMINI_API_KEY not set' }); return res.end(); }

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    // ── Render question pages ──────────────────────────────────────────────
    send('status', { message: 'Rendering question PDF pages…', step: 1, totalSteps: 3 });
    const { pages: qPages, pageCount: qCount } = await renderPdfPages(browser, qPdf.buffer, 1.8);
    send('status', { message: `Questions PDF: ${qCount} pages rendered`, step: 1, totalSteps: 3 });

    // ── Render answer pages ────────────────────────────────────────────────
    let aPages = [];
    if (aPdf) {
      send('status', { message: 'Rendering answer PDF pages…', step: 2, totalSteps: 3 });
      const { pages, pageCount: aCount } = await renderPdfPages(browser, aPdf.buffer, 1.8);
      aPages = pages;
      send('status', { message: `Answers PDF: ${aCount} pages rendered`, step: 2, totalSteps: 3 });
    }

    await browser.close();
    browser = null;

    // ── Pair and extract ───────────────────────────────────────────────────
    const total = qPages.length;
    send('start', { total, qPages: qPages.length, aPages: aPages.length, step: 3, totalSteps: 3 });

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    for (let i = 0; i < total; i++) {
      send('pair_start', { pair: i + 1, total });
      try {
        const data = await extractFromImages(
          ai,
          qPages[i], 'image/png',
          aPages[i] || null, 'image/png'
        );
        send('pair_done', { pair: i + 1, total, questions: data.questions, page_notes: data.page_notes || '' });
      } catch (err) {
        send('pair_error', { pair: i + 1, total, error: err.message });
      }
      if (i < total - 1) await new Promise(r => setTimeout(r, 800));
    }

    send('complete', { total });
  } catch (err) {
    console.error('Dual PDF error:', err.message);
    send('error', { message: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
    clearInterval(hb);
    res.end();
  }
});

// GET /api/batch/thumb/:jobId/:pageNum — serve thumbnail from temp
app.get('/api/batch/thumb/:jobId/:pageNum', (req, res) => {
  const f = path.join(TEMP_DIR, req.params.jobId, `p${String(parseInt(req.params.pageNum)).padStart(4, '0')}.png`);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.send(fs.readFileSync(f));
});

// ─── Review Routes ────────────────────────────────────────────────────────────

const DECISIONS_PATH = path.join(DATA_DIR, 'review_decisions.json');

// GET /api/review/questions?subject=&page=&limit=&search=&difficulty=&db=premium|all
// Returns paginated slice + saved decisions for that slice
app.get('/api/review/questions', (req, res) => {
  try {
    const dbFile  = req.query.db === 'all' ? 'questions.json' : 'questions_premium.json';
    const dbPath  = path.join(DATA_DIR, dbFile);
    const decPath = path.join(DATA_DIR, `review_decisions_${req.query.db === 'all' ? 'all' : 'premium'}.json`);
    if (!fs.existsSync(dbPath)) return res.json({ questions: [], decisions: {}, total: 0, subjects: [] });

    const allQ     = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    let decisions  = {};
    if (fs.existsSync(decPath)) {
      try { decisions = JSON.parse(fs.readFileSync(decPath, 'utf-8')); } catch {}
    }

    const subject    = req.query.subject    || '';
    const difficulty = req.query.difficulty || '';
    const search     = (req.query.search    || '').toLowerCase();
    const page       = Math.max(1, parseInt(req.query.page)  || 1);
    const limit      = Math.min(100, Math.max(10, parseInt(req.query.limit) || 50));

    // Build subject list with counts
    const subjectCounts = {};
    allQ.forEach(q => { const s = q.subject||'unknown'; subjectCounts[s] = (subjectCounts[s]||0)+1; });

    // Build difficulty counts
    const diffCounts = { easy: 0, medium: 0, hard: 0 };
    allQ.forEach(q => { const d = q.difficulty||'medium'; if (diffCounts[d] !== undefined) diffCounts[d]++; });

    // Filter
    let filtered = allQ;
    if (subject)    filtered = filtered.filter(q => (q.subject||'unknown') === subject);
    if (difficulty) filtered = filtered.filter(q => (q.difficulty||'medium') === difficulty);
    if (search)     filtered = filtered.filter(q => (q.stem||'').toLowerCase().includes(search));

    const total  = filtered.length;
    const start  = (page - 1) * limit;
    const slice  = filtered.slice(start, start + limit);

    // Only send decisions for this slice (keeps response small)
    const sliceDecisions = {};
    slice.forEach(q => { if (decisions[q.id]) sliceDecisions[q.id] = decisions[q.id]; });

    // Summary counts
    const kept     = Object.values(decisions).filter(v => v === 'kept').length;
    const rejected = Object.values(decisions).filter(v => v === 'rejected').length;

    res.json({
      questions: slice,
      decisions: sliceDecisions,
      total,
      page,
      pages: Math.ceil(total / limit),
      subjects: Object.entries(subjectCounts).sort((a,b) => b[1]-a[1]).map(([s,c]) => ({ subject: s, count: c })),
      difficulty_counts: diffCounts,
      summary: { total: allQ.length, kept, rejected, pending: allQ.length - kept - rejected }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/review/save — persist decisions map { [id]: 'kept'|'rejected'|'pending', db: 'premium'|'all' }
app.post('/api/review/save', (req, res) => {
  try {
    const { decisions, db } = req.body;
    if (!decisions || typeof decisions !== 'object')
      return res.status(400).json({ error: 'decisions object required' });

    const decPath = path.join(DATA_DIR, db === 'all' ? 'review_decisions_all.json' : 'review_decisions_premium.json');

    // Merge with existing decisions (don't overwrite unreviewed)
    let existing = {};
    if (fs.existsSync(decPath)) {
      try { existing = JSON.parse(fs.readFileSync(decPath, 'utf-8')); } catch {}
    }
    const merged = { ...existing, ...decisions };
    // Remove 'pending' keys to keep file lean
    Object.keys(merged).forEach(k => { if (merged[k] === 'pending') delete merged[k]; });
    fs.writeFileSync(decPath, JSON.stringify(merged));

    const kept     = Object.values(merged).filter(v => v === 'kept').length;
    const rejected = Object.values(merged).filter(v => v === 'rejected').length;
    res.json({ success: true, kept, rejected, total: Object.keys(merged).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/review/difficulty — update difficulty for a batch of questions { changes: { id: 'easy'|'medium'|'hard' }, db: 'premium'|'all' }
app.post('/api/review/difficulty', (req, res) => {
  try {
    const { changes, db } = req.body;
    if (!changes || typeof changes !== 'object')
      return res.status(400).json({ error: 'changes object required' });

    const dbFile  = db === 'all' ? 'questions.json' : 'questions_premium.json';
    const dbPath  = path.join(DATA_DIR, dbFile);
    const questions = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    let updated = 0;
    const changeMap = new Map(Object.entries(changes));
    const result = questions.map(q => {
      if (changeMap.has(q.id)) { updated++; return { ...q, difficulty: changeMap.get(q.id) }; }
      return q;
    });
    fs.writeFileSync(dbPath, JSON.stringify(result, null, 2));
    res.json({ success: true, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/review/apply — write a new questions file keeping only 'kept' questions
app.post('/api/review/apply', (req, res) => {
  try {
    const { db } = req.body || {};
    const dbFile  = db === 'all' ? 'questions.json' : 'questions_premium.json';
    const decFile = db === 'all' ? 'review_decisions_all.json' : 'review_decisions_premium.json';
    const dbPath  = path.join(DATA_DIR, dbFile);
    const decPath = path.join(DATA_DIR, decFile);

    if (!fs.existsSync(dbPath))  return res.status(400).json({ error: `${dbFile} not found` });
    if (!fs.existsSync(decPath)) return res.status(400).json({ error: 'No decisions saved yet' });

    const questions = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    const decisions = JSON.parse(fs.readFileSync(decPath, 'utf-8'));

    const kept = questions.filter(q => decisions[q.id] === 'kept');

    // Backup original
    fs.writeFileSync(path.join(DATA_DIR, 'questions_pre_review.json'), JSON.stringify(questions));
    fs.writeFileSync(dbPath, JSON.stringify(kept, null, 2));

    res.json({ success: true, original: questions.length, kept: kept.length, removed: questions.length - kept.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  FMGE AI Generator running at http://localhost:${PORT}`);
  console.log(`  Upload PDFs or DOC files and get 3 AI variations with full PDF export\n`);
});
