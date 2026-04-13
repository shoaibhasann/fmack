#!/usr/bin/env node
/**
 * MedMCQA Import Script
 * ─────────────────────
 * Downloads MedMCQA parquet files from HuggingFace, filters to:
 *   - FMGE-relevant subjects only
 *   - Questions that have an explanation (exp != null)
 *   - source_type = 'practice'
 * Then appends to data/questions.json with full deduplication.
 *
 * Usage:  node scripts/import-medmcqa.js
 * Flags:  --dry-run   (count + preview, no write)
 *         --limit N   (import max N questions, for testing)
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');

// hyparquet is ESM-only — loaded via dynamic import in main()
let parquetRead;

// ── CLI flags ────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT   = limitArg ? parseInt(limitArg.split('=')[1]) : Infinity;

// ── FMGE Subject Map ─────────────────────────────────────────────────────────
// MedMCQA subject_name → our normalized subject key
// Excluded: Dental, Radiology, Unknown (not in FMGE syllabus)
const FMGE_SUBJECT_MAP = {
  // Anatomy & basic sciences
  'Anatomy':                        'anatomy',
  'Physiology':                     'physiology',
  'Biochemistry':                   'biochemistry',
  'Pathology':                      'pathology',
  'Pharmacology':                   'pharmacology',
  'Microbiology':                   'microbiology',
  // FMT
  'Forensic Medicine':              'forensic-medicine',
  'Forensic Medicine And Toxicology': 'forensic-medicine',
  // PSM / Community Medicine
  'Preventive & Social Medicine':   'psm',
  'Social & Preventive Medicine':   'psm',   // actual name in dataset
  'Community Medicine':             'psm',
  // Clinical subjects
  'Medicine':                       'medicine',
  'Surgery':                        'surgery',
  'Obstetrics & Gynecology':        'obstetrics-gynecology',
  'Obstetrics And Gynaecology':     'obstetrics-gynecology',
  'Gynaecology & Obstetrics':       'obstetrics-gynecology', // actual name in dataset
  'Pediatrics':                     'pediatrics',
  'Paediatrics':                    'pediatrics',
  'Psychiatry':                     'psychiatry',
  'Ophthalmology':                  'ophthalmology',
  'ENT':                            'ent',
  'Ear Nose Throat':                'ent',
  'Orthopaedics':                   'orthopedics',
  'Orthopedics':                    'orthopedics',
  'Anaesthesia':                    'anesthesia',  // actual name in dataset
  'Anesthesia':                     'anesthesia',
  'Skin':                           'dermatology',
  'Dermatology':                    'dermatology',
};

// cop values: 0=a, 1=b, 2=c, 3=d  (stored as BigInt in parquet — use Number())
const COP_MAP = { 0: 'a', 1: 'b', 2: 'c', 3: 'd' };

// HuggingFace parquet URLs — all 3 splits (train=182k, val=NEET PG 4k, test=AIIMS PG 6k)
// Use --only=train / --only=val / --only=test to run a single split
const splitArg = (args.find(a => a.startsWith('--only=')) || '').replace('--only=', '');

const ALL_SOURCES = [
  {
    url:   'https://huggingface.co/api/datasets/openlifescienceai/medmcqa/parquet/default/train/0.parquet',
    label: 'Train (182k – mixed PG prep)',
    split: 'train'
  },
  {
    url:   'https://huggingface.co/api/datasets/openlifescienceai/medmcqa/parquet/default/validation/0.parquet',
    label: 'Validation (NEET PG ~4k)',
    split: 'neet-pg'
  },
  {
    url:   'https://huggingface.co/api/datasets/openlifescienceai/medmcqa/parquet/default/test/0.parquet',
    label: 'Test (AIIMS PG ~6k)',
    split: 'aiims-pg'
  }
];

const PARQUET_SOURCES = splitArg
  ? ALL_SOURCES.filter(s => s.split === splitArg || s.split.startsWith(splitArg))
  : ALL_SOURCES;

const DATA_DIR   = path.join(__dirname, '..', 'data');
const DB_PATH    = path.join(DATA_DIR, 'questions.json');
const CACHE_DIR  = path.join(__dirname, '..', 'temp', 'medmcqa_cache');

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg)  { process.stdout.write(msg + '\n'); }
function info(msg) { process.stdout.write('\x1b[36m' + msg + '\x1b[0m\n'); }
function ok(msg)   { process.stdout.write('\x1b[32m✓ ' + msg + '\x1b[0m\n'); }
function warn(msg) { process.stdout.write('\x1b[33m⚠ ' + msg + '\x1b[0m\n'); }

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let resolved = false;

    function doGet(u, redirects) {
      if (redirects > 10) { reject(new Error('Too many redirects')); return; }
      const proto = u.startsWith('https') ? https : http;
      proto.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 node-import/1.0' } }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          // Consume body to free socket, then follow redirect
          res.resume();
          doGet(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0');
        let got = 0;
        res.on('data', chunk => {
          got += chunk.length;
          const mb  = (got  / 1024 / 1024).toFixed(1);
          const tot = (total / 1024 / 1024).toFixed(1);
          const pct = total > 0 ? Math.round((got / total) * 100) : '?';
          process.stdout.write(`\r  Downloading… ${pct}% (${mb} / ${tot} MB)   `);
        });
        res.pipe(file);
        res.on('end', () => {
          if (!resolved) { resolved = true; process.stdout.write('\n'); resolve(); }
        });
        res.on('error', reject);
      }).on('error', reject);
    }

    doGet(url, 0);
    file.on('error', reject);
  });
}

/** Split a long explanation string into bullet array */
function parseExplanation(exp) {
  if (!exp || typeof exp !== 'string') return [];
  const trimmed = exp.trim();
  if (!trimmed) return [];

  // Split on bullet chars or numbered list patterns
  const lines = trimmed
    .split(/\n/)
    .map(l => l.replace(/^[\s•\-\*\d]+[\.\)]\s*/, '').trim())
    .filter(l => l.length > 10);

  if (lines.length <= 1) {
    // Single block — split by sentences if very long, otherwise keep as one
    if (trimmed.length < 300) return [trimmed];
    const sentences = trimmed.match(/[^.!?]+[.!?]+/g) || [trimmed];
    return sentences.map(s => s.trim()).filter(s => s.length > 20).slice(0, 6);
  }

  // Merge wrapped continuation lines (no sentence boundary at end of prev)
  const points = [];
  for (const line of lines) {
    if (points.length > 0 && !/[.!?:)]$/.test(points[points.length - 1])) {
      points[points.length - 1] += ' ' + line;
    } else {
      points.push(line);
    }
  }
  return points.slice(0, 6);
}

/** Map one MedMCQA row to our question schema */
function mapRow(row, split) {
  const subjectRaw = row.subject_name || '';
  const subject    = FMGE_SUBJECT_MAP[subjectRaw];
  if (!subject) return null;                          // not FMGE subject

  const exp = row.exp;
  if (!exp || (typeof exp === 'string' && exp.trim().length < 5)) return null; // no explanation

  // cop is stored as BigInt in parquet — convert to plain number
  const cop = Number(row.cop);
  const correctOption = COP_MAP[cop];
  if (!correctOption) return null;

  const opts = { a: row.opa, b: row.opb, c: row.opc, d: row.opd };
  if (!opts.a || !opts.b || !opts.c || !opts.d) return null; // skip incomplete options

  const explanation = parseExplanation(exp);
  if (!explanation.length) return null;

  // Source label per split
  const sourceLabel = split === 'neet-pg'  ? 'NEET PG (MedMCQA)' :
                      split === 'aiims-pg' ? 'AIIMS PG (MedMCQA)' :
                                             'MedMCQA Practice';

  return {
    id:                  `medmcqa_${row.id}`,
    stem:                (row.question || '').trim(),
    option_a:            (row.opa || '').trim(),
    option_b:            (row.opb || '').trim(),
    option_c:            (row.opc || '').trim(),
    option_d:            (row.opd || '').trim(),
    correct_option:      correctOption,
    correct_answer_text: (opts[correctOption] || '').trim(),
    explanation,
    source:              sourceLabel,
    source_type:         'practice',
    subject,
    topic:               (row.topic_name || null),
    difficulty:          'medium',
    has_image:           false,
    image_url:           null,
    image_description:   null,
    tags:                ['practice', 'medmcqa', split],
    created_at:          new Date().toISOString()
  };
}

/** Read parquet file and return array of row objects */
async function readParquet(filePath) {
  const buffer = fs.readFileSync(filePath);

  // Must be a clean ArrayBuffer (not a Node.js Buffer slice) for hyparquet
  const arrayBuf = new ArrayBuffer(buffer.length);
  new Uint8Array(arrayBuf).set(buffer);

  const asyncBuffer = {
    byteLength: arrayBuf.byteLength,
    slice: async (start, end) => arrayBuf.slice(start, end)
  };

  let rows = [];
  await parquetRead({
    file:       asyncBuffer,
    rowFormat:  'object',
    onComplete: (data) => { rows = data || []; }
  });
  return rows;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load ESM-only hyparquet via dynamic import
  ({ parquetRead } = await import('hyparquet'));

  log('');
  info('━━━ MedMCQA Import Script ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (DRY_RUN) warn('DRY RUN — no data will be written');
  log('');

  // Ensure dirs exist
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR,  { recursive: true });

  // Load existing DB for dedup
  let existing = [];
  if (fs.existsSync(DB_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); } catch {}
  }
  const existingIds   = new Set(existing.map(q => q.id));
  const existingStems = new Set(existing.map(q => (q.stem || '').slice(0, 80).toLowerCase().trim()));
  info(`Existing questions in DB: ${existing.length}`);
  log('');

  const allImported = [];
  const stats = { total: 0, fmge_match: 0, has_exp: 0, imported: 0, dupes: 0, skipped_subject: 0 };

  for (const source of PARQUET_SOURCES) {
    info(`━━ ${source.label}`);

    // Cache parquet locally so re-runs are fast
    const cacheFile = path.join(CACHE_DIR, `${source.split}.parquet`);
    if (fs.existsSync(cacheFile)) {
      const sizeMB = (fs.statSync(cacheFile).size / 1024 / 1024).toFixed(1);
      ok(`Using cached file (${sizeMB} MB): ${cacheFile}`);
    } else {
      log(`  Downloading from HuggingFace…`);
      await downloadFile(source.url, cacheFile);
      ok(`Downloaded → ${cacheFile}`);
    }

    log('  Parsing parquet…');
    const rows = await readParquet(cacheFile);
    log(`  Rows in file: ${rows.length.toLocaleString()}`);
    stats.total += rows.length;

    let fileImported = 0, fileDupes = 0, fileSkippedSubj = 0, fileNoExp = 0;

    for (const row of rows) {
      if (allImported.length >= LIMIT) break;

      // Subject filter
      if (!FMGE_SUBJECT_MAP[row.subject_name]) {
        fileSkippedSubj++;
        stats.skipped_subject++;
        continue;
      }
      stats.fmge_match++;

      // Explanation filter
      if (!row.exp || row.exp.trim().length < 5) {
        fileNoExp++;
        continue;
      }
      stats.has_exp++;

      const mapped = mapRow(row, source.split);
      if (!mapped || !mapped.stem || mapped.stem.length < 10) continue;

      // Dedup by ID and stem
      const stemKey = mapped.stem.slice(0, 80).toLowerCase().trim();
      if (existingIds.has(mapped.id) || existingStems.has(stemKey)) {
        fileDupes++;
        stats.dupes++;
        continue;
      }

      existingIds.add(mapped.id);
      existingStems.add(stemKey);
      allImported.push(mapped);
      fileImported++;
      stats.imported++;
    }

    log(`  FMGE subjects matched: ${(rows.length - fileSkippedSubj).toLocaleString()}`);
    log(`  No explanation (skipped): ${fileNoExp.toLocaleString()}`);
    log(`  Duplicates skipped: ${fileDupes.toLocaleString()}`);
    ok(`Imported from this split: ${fileImported.toLocaleString()}`);
    log('');
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  info('━━ Import Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`  Total rows processed  : ${stats.total.toLocaleString()}`);
  log(`  FMGE subject match    : ${stats.fmge_match.toLocaleString()}`);
  log(`  Had explanation       : ${stats.has_exp.toLocaleString()}`);
  log(`  Duplicates skipped    : ${stats.dupes.toLocaleString()}`);
  log(`  Imported this run     : ${stats.imported.toLocaleString()}`);

  // Subject breakdown
  const bySub = {};
  for (const q of allImported) {
    bySub[q.subject] = (bySub[q.subject] || 0) + 1;
  }
  log('\n  Breakdown by subject:');
  Object.entries(bySub).sort((a,b) => b[1]-a[1]).forEach(([s,c]) => {
    log(`    ${s.padEnd(28)} ${c.toLocaleString()}`);
  });

  if (DRY_RUN) {
    warn('\nDry run complete — nothing written.');
    log('Sample question:');
    if (allImported[0]) console.log(JSON.stringify(allImported[0], null, 2));
    return;
  }

  if (allImported.length === 0) {
    warn('Nothing new to import.');
    return;
  }

  // Write to DB
  const updated = [...existing, ...allImported];
  fs.writeFileSync(DB_PATH, JSON.stringify(updated, null, 2));
  ok(`\nSaved ${allImported.length.toLocaleString()} questions → data/questions.json`);
  ok(`Total questions in DB now: ${updated.length.toLocaleString()}`);
}

main().catch(err => {
  process.stderr.write('\nERROR: ' + err.message + '\n');
  process.exit(1);
});
