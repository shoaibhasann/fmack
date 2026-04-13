#!/usr/bin/env node
/**
 * Gemini FMGE Quality Filter
 * ──────────────────────────
 * Sends all questions to Gemini 2.5 Flash in batches of 15.
 * Approves only 10-15% — premium, FMGE-relevant questions.
 * Fully resumable: checkpoint saved after every batch.
 *
 * Usage:
 *   node scripts/gemini-filter.js            → run / resume
 *   node scripts/gemini-filter.js --status   → show progress only
 *   node scripts/gemini-filter.js --apply    → write final approved/rejected files
 */

'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

// ── Config ────────────────────────────────────────────────────────────────────
const BATCH_SIZE   = 15;    // questions per Gemini call
const CONCURRENCY  = 18;    // simultaneous API calls
const MAX_RETRIES  = 4;
const RETRY_DELAY  = 3000;  // ms base delay for retries
// gemini-2.5-flash-lite: cheaper, lower demand, perfect for bulk filtering
const MODEL        = process.env.GEMINI_FILTER_MODEL || 'gemini-2.5-flash-lite';

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT            = path.join(__dirname, '..');
const QUESTIONS_PATH  = path.join(ROOT, 'data', 'questions.json');
const CHECKPOINT_PATH = path.join(ROOT, 'temp', 'gemini_filter_checkpoint.jsonl');
const APPROVED_PATH   = path.join(ROOT, 'data', 'questions_premium.json');
const REJECTED_PATH   = path.join(ROOT, 'data', 'questions_rejected.json');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const STATUS  = args.includes('--status');
const APPLY   = args.includes('--apply');

// ── Gemini prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a brutally strict FMGE paper setter reviewing questions for a premium FMGE question bank. You must REJECT 85-90% of questions. Only 1-2 out of every 15 should survive.

KEEP only if the question is ALL of:
- A HIGH-YIELD FMGE concept that directly aligns with FMGE exam pattern
- Tests clinical application or real patient scenario (not pure theory)
- Has a definitive single correct answer with clear clinical logic
- Would genuinely differentiate a passing from failing FMGE candidate

REJECT if ANY of these apply:
- General PG-level question not aligned with FMGE pattern
- Tests obscure subspecialty facts unlikely in FMGE
- Pure definition, pure memorization, or first-year basic science only
- Could have multiple defensible answers or is ambiguous
- Would be answered correctly by guessing or common sense alone

DIFFICULTY (re-assess accurately):
- easy: widely known clinical fact, first-line treatment, classic presentation
- medium: requires clinical reasoning, differential diagnosis, mechanism
- hard: complex scenario, multi-step reasoning, advanced pathophysiology

Be VERY harsh. When in doubt, REJECT. Return JSON array ONLY: [{id, keep, difficulty, reason}] where reason is MAX 4 WORDS. No text outside JSON.`;

// ── Helpers ───────────────────────────────────────────────────────────────────
const c = {
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
};

function log(msg)  { process.stdout.write(msg + '\n'); }
function clrLine() { process.stdout.write('\r\x1b[K'); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatTime(sec) {
  if (sec < 60)   return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ${Math.round(sec%60)}s`;
  return `${Math.floor(sec/3600)}h ${Math.floor((sec%3600)/60)}m`;
}

// ── Load checkpoint → Set of already-processed question IDs ──────────────────
function loadCheckpoint() {
  const done    = new Set();   // question IDs already processed
  const results = new Map();   // id → { keep, difficulty, reason }

  if (!fs.existsSync(CHECKPOINT_PATH)) return { done, results };
  const lines = fs.readFileSync(CHECKPOINT_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const batch = JSON.parse(line);
      for (const r of (batch.results || [])) {
        done.add(r.id);
        results.set(r.id, { keep: r.keep, difficulty: r.difficulty, reason: r.reason });
      }
    } catch {}
  }
  return { done, results };
}

// ── Append one batch result to checkpoint ────────────────────────────────────
function appendCheckpoint(results) {
  const line = JSON.stringify({ ts: new Date().toISOString(), results }) + '\n';
  fs.appendFileSync(CHECKPOINT_PATH, line);
}

// ── Parse Gemini JSON response safely ────────────────────────────────────────
function parseGeminiResponse(text, batch) {
  // Strip markdown fences if present
  let clean = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  // Sometimes Gemini wraps in object — unwrap
  if (clean.startsWith('{')) {
    try {
      const obj = JSON.parse(clean);
      if (Array.isArray(obj.results)) clean = JSON.stringify(obj.results);
    } catch {}
  }
  try {
    const arr = JSON.parse(clean);
    if (!Array.isArray(arr)) throw new Error('not array');
    return arr;
  } catch {
    // Fall back: extract individual objects
    const objs = [];
    const matches = clean.matchAll(/\{[^{}]+\}/g);
    for (const m of matches) {
      try { objs.push(JSON.parse(m[0])); } catch {}
    }
    if (objs.length > 0) return objs;
    // Last resort: mark all as rejected to not lose progress
    return batch.map(q => ({ id: q.id, keep: false, difficulty: q.difficulty || 'medium', reason: 'parse error' }));
  }
}

// ── Single batch API call with retry ─────────────────────────────────────────
async function processBatch(ai, batch, batchIdx) {
  const questionsText = batch.map((q, i) => {
    const opts = ['a','b','c','d'].map(o => `  ${o.toUpperCase()}. ${q['option_'+o]||''}`).join('\n');
    const expl = Array.isArray(q.explanation) ? q.explanation.join(' ') : (q.explanation || '');
    return `[${i+1}] ID: ${q.id}\nSubject: ${q.subject||'unknown'}\nQ: ${q.stem}\nOptions:\n${opts}\nCorrect: ${(q.correct_option||'?').toUpperCase()}\nExplanation: ${expl.slice(0,200)}`;
  }).join('\n\n---\n\n');

  const userContent = `Review these ${batch.length} MCQs. Return JSON array with one object per question.\n\n${questionsText}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await ai.models.generateContent({
        model:    MODEL,
        contents: [
          { role: 'user', parts: [{ text: SYSTEM_PROMPT + '\n\n' + userContent }] }
        ],
        config: {
          temperature:      0.1,
          maxOutputTokens:  2048,
          responseMimeType: 'application/json',
        }
      });

      const text = result.text || result.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = parseGeminiResponse(text, batch);

      // Ensure every question in batch has a result (fill missing as rejected)
      const resultMap = new Map(parsed.map(r => [r.id, r]));
      return batch.map(q => resultMap.get(q.id) || { id: q.id, keep: false, difficulty: q.difficulty || 'medium', reason: 'no response' });

    } catch (err) {
      const isRateLimit = err.message?.includes('429') || err.message?.includes('quota') || err.message?.includes('rate');
      const delay = isRateLimit ? RETRY_DELAY * attempt * 2 : RETRY_DELAY * attempt;
      if (attempt < MAX_RETRIES) {
        await sleep(delay);
      } else {
        // On final failure mark all rejected (so progress is saved and we can continue)
        return batch.map(q => ({ id: q.id, keep: false, difficulty: q.difficulty || 'medium', reason: `api error: ${err.message.slice(0,30)}` }));
      }
    }
  }
}

// ── Concurrent queue ──────────────────────────────────────────────────────────
async function runConcurrent(tasks, concurrency, fn) {
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < tasks.length) {
      const i = idx++;
      await fn(tasks[i], i);
    }
  });
  await Promise.all(workers);
}

// ── Status display ────────────────────────────────────────────────────────────
function showStatus() {
  if (!fs.existsSync(QUESTIONS_PATH)) { log(c.red('questions.json not found')); return; }
  const total   = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf-8')).length;
  const { done, results } = loadCheckpoint();

  const kept = [...results.values()].filter(r => r.keep).length;
  const rej  = [...results.values()].filter(r => !r.keep).length;
  const pct  = total > 0 ? (done.size / total * 100).toFixed(1) : '0';
  const apRate = done.size > 0 ? (kept / done.size * 100).toFixed(1) : '0';

  log(c.cyan('\n━━ Gemini Filter Status ━━━━━━━━━━━━━━━━━━━━━━━━'));
  log(`  Total questions   : ${c.bold(total.toLocaleString())}`);
  log(`  Processed         : ${c.bold(done.size.toLocaleString())} (${pct}%)`);
  log(`  Remaining         : ${c.yellow((total - done.size).toLocaleString())}`);
  log(`  Approved (keep)   : ${c.green(kept.toLocaleString())} (${apRate}%)`);
  log(`  Rejected          : ${c.red(rej.toLocaleString())}`);
  log(`  Checkpoint file   : ${CHECKPOINT_PATH}`);

  const remaining = total - done.size;
  if (remaining > 0) {
    const estBatches = Math.ceil(remaining / BATCH_SIZE);
    const estSec     = estBatches / CONCURRENCY * 2.5;
    log(`\n  Est. time to finish: ${c.yellow(formatTime(estSec))} at ${CONCURRENCY} concurrent`);
  } else {
    log(c.green('\n  All questions processed! Run --apply to generate final files.'));
  }
  log('');
}

// ── Apply: build final output files ──────────────────────────────────────────
function applyResults() {
  log(c.cyan('\n━━ Applying Filter Results ━━━━━━━━━━━━━━━━━━━━━━'));

  if (!fs.existsSync(QUESTIONS_PATH)) { log(c.red('questions.json not found')); return; }
  if (!fs.existsSync(CHECKPOINT_PATH)) { log(c.red('No checkpoint found. Run filter first.')); return; }

  const questions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf-8'));
  const { done, results } = loadCheckpoint();

  log(`  Questions in DB   : ${questions.length.toLocaleString()}`);
  log(`  Processed in checkpoint: ${done.size.toLocaleString()}`);

  // Map questions by ID
  const qMap = new Map(questions.map(q => [q.id, q]));

  // Separate approved vs rejected
  const approved = [];
  const rejected = [];

  for (const [id, r] of results.entries()) {
    const q = qMap.get(id);
    if (!q) continue;
    if (r.keep) {
      approved.push({ ...q, difficulty: r.difficulty || q.difficulty, gemini_reason: r.reason, gemini_reviewed: true });
    } else {
      rejected.push({ ...q, gemini_reason: r.reason, gemini_reviewed: true });
    }
  }

  // Any unprocessed questions → treat as unreviewed (not included in either file)
  const unreviewed = questions.filter(q => !done.has(q.id));
  log(`  Unreviewed        : ${unreviewed.length.toLocaleString()}`);

  // Deduplicate approved by first 80 chars of stem
  const seenStems = new Set();
  const deduped   = [];
  let dupes = 0;
  for (const q of approved) {
    const key = (q.stem || '').slice(0, 80).toLowerCase().trim();
    if (seenStems.has(key)) { dupes++; continue; }
    seenStems.add(key);
    deduped.push(q);
  }

  // Sort by subject then difficulty
  const diffOrder = { easy: 0, medium: 1, hard: 2 };
  deduped.sort((a, b) => {
    const sc = (a.subject||'').localeCompare(b.subject||'');
    if (sc !== 0) return sc;
    return (diffOrder[a.difficulty]||1) - (diffOrder[b.difficulty]||1);
  });

  // Write outputs
  fs.writeFileSync(APPROVED_PATH, JSON.stringify(deduped, null, 2));
  fs.writeFileSync(REJECTED_PATH, JSON.stringify(rejected, null, 2));

  const approvalRate = done.size > 0 ? (deduped.length / done.size * 100).toFixed(1) : '0';

  log('');
  log(c.green(`  ✓ Approved (premium)  : ${deduped.length.toLocaleString()} questions (${approvalRate}%)`));
  log(c.red(`    Rejected             : ${rejected.length.toLocaleString()} questions`));
  log(c.yellow(`    Dupes removed        : ${dupes.toLocaleString()}`));
  log(c.dim(`    Unreviewed (skipped) : ${unreviewed.length.toLocaleString()}`));

  // Breakdown by subject
  const bySub = {};
  deduped.forEach(q => { bySub[q.subject||'unknown'] = (bySub[q.subject||'unknown']||0)+1; });
  log('\n  By subject:');
  Object.entries(bySub).sort((a,b)=>b[1]-a[1]).forEach(([s,n]) => {
    log(`    ${s.padEnd(28)} ${n.toLocaleString()}`);
  });

  // Difficulty breakdown
  const byDiff = { easy: 0, medium: 0, hard: 0 };
  deduped.forEach(q => { const d = q.difficulty||'medium'; if (byDiff[d]!==undefined) byDiff[d]++; });
  log('\n  By difficulty:');
  log(`    Easy   : ${byDiff.easy.toLocaleString()}`);
  log(`    Medium : ${byDiff.medium.toLocaleString()}`);
  log(`    Hard   : ${byDiff.hard.toLocaleString()}`);

  log(c.green(`\n  ✓ Saved → data/questions_premium.json`));
  log(c.dim(`    Saved → data/questions_rejected.json\n`));
}

// ── Main filter run ───────────────────────────────────────────────────────────
async function main() {
  if (STATUS) { showStatus(); return; }
  if (APPLY)  { applyResults(); return; }

  if (!process.env.GEMINI_API_KEY) {
    log(c.red('ERROR: GEMINI_API_KEY not set in .env')); process.exit(1);
  }
  if (!fs.existsSync(QUESTIONS_PATH)) {
    log(c.red('ERROR: data/questions.json not found')); process.exit(1);
  }

  const ai        = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf-8'));
  const { done, results: existingResults } = loadCheckpoint();

  // Filter to unprocessed only
  const remaining = questions.filter(q => !done.has(q.id));
  const total     = questions.length;
  const alreadyDone = total - remaining.length;

  // Split remaining into batches
  const batches = [];
  for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
    batches.push(remaining.slice(i, i + BATCH_SIZE));
  }

  log('');
  log(c.cyan('━━━ Gemini FMGE Quality Filter ━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  log(`  Model             : ${MODEL}`);
  log(`  Total questions   : ${c.bold(total.toLocaleString())}`);
  log(`  Already processed : ${c.green(alreadyDone.toLocaleString())}`);
  log(`  To process now    : ${c.yellow(remaining.length.toLocaleString())}`);
  log(`  Batches (${BATCH_SIZE}/call) : ${batches.length.toLocaleString()}`);
  log(`  Concurrency       : ${CONCURRENCY}`);
  log(`  Est. time         : ${c.yellow(formatTime(batches.length / CONCURRENCY * 2.8))}`);
  const inputTokensM  = (remaining.length * 148 + batches.length * 300) / 1e6;
  const outputTokensM = (batches.length * BATCH_SIZE * 25) / 1e6;
  log(`  Est. cost         : ${c.bold('$'+(inputTokensM*0.075 + outputTokensM*0.30).toFixed(2))}`);
  log('');
  if (remaining.length === 0) {
    log(c.green('All questions already processed! Run --apply to generate final files.'));
    return;
  }

  // ── Progress tracking ────────────────────────────────────────────────────
  let processed   = 0;
  let kept        = [...existingResults.values()].filter(r => r.keep).length;
  let totalKept   = kept;
  let errors      = 0;
  const startTime = Date.now();
  const mu        = {};   // mutex per worker slot (unused but kept for clarity)

  // Ensure temp dir
  if (!fs.existsSync(path.dirname(CHECKPOINT_PATH))) {
    fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
  }

  function printProgress() {
    const elapsed   = (Date.now() - startTime) / 1000;
    const rate      = processed / Math.max(elapsed, 1);   // batches per sec
    const remaining2 = batches.length - processed;
    const eta       = rate > 0 ? remaining2 / rate : 0;
    const totalProc = alreadyDone + processed * BATCH_SIZE;
    const pct       = (totalProc / total * 100).toFixed(1);
    const apRate    = totalProc > 0 ? ((totalKept) / totalProc * 100).toFixed(1) : '0';

    clrLine();
    process.stdout.write(
      `  [${pct}%] Batches: ${processed}/${batches.length} | ` +
      `Kept: ${c.green(totalKept.toLocaleString())} (${apRate}%) | ` +
      `Errors: ${errors > 0 ? c.red(errors) : '0'} | ` +
      `ETA: ${c.yellow(formatTime(eta))}`
    );
  }

  // ── Process all batches concurrently ────────────────────────────────────
  await runConcurrent(batches, CONCURRENCY, async (batch, batchIdx) => {
    const batchResults = await processBatch(ai, batch, batchIdx);

    // Count errors in this batch
    const errCount = batchResults.filter(r => (r.reason||'').includes('api error') || (r.reason||'').includes('parse error')).length;
    if (errCount > 0) errors += errCount;

    // Count kept in this batch
    const batchKept = batchResults.filter(r => r.keep).length;
    totalKept += batchKept;

    // Save to checkpoint (atomic append)
    appendCheckpoint(batchResults);

    processed++;
    printProgress();
  });

  // Final newline after progress
  process.stdout.write('\n');
  log('');

  const elapsed = (Date.now() - startTime) / 1000;
  const grandTotal = alreadyDone + remaining.length;
  const apRate = (totalKept / grandTotal * 100).toFixed(1);

  log(c.green('━━ Filter Complete ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  log(`  Processed this run: ${(remaining.length).toLocaleString()} questions`);
  log(`  Time taken        : ${formatTime(elapsed)}`);
  log(`  Kept (approved)   : ${c.green(totalKept.toLocaleString())} (${apRate}%)`);
  if (errors > 0) log(`  API errors        : ${c.yellow(errors.toLocaleString())} (marked rejected, can re-run to retry)`);
  log('');
  log(c.cyan('  Next step: node scripts/gemini-filter.js --apply'));
  log(c.dim('  (Generates data/questions_premium.json with deduplication)'));
  log('');
}

main().catch(err => {
  process.stdout.write('\n');
  process.stderr.write(c.red('FATAL: ') + err.message + '\n');
  process.exit(1);
});
