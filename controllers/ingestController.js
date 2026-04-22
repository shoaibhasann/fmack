// ─── Ingest Controller ─────────────────────────────────────────────────────────
// Handles the AI-assisted question ingestion flow (scan → extract → save).
//
// POST /api/ingest/extract       — 2 images → Gemini Vision → structured questions
// POST /api/ingest/save          — save approved questions to data/questions.json
// POST /api/ingest/upload-image  — store question diagram to disk
// GET  /api/ingest/stats         — question bank summary counts
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleGenAI }  from '@google/genai';
import fs               from 'fs';
import path             from 'path';
import { parseGeminiJSON } from '../helpers/gemini.js';
import { UPLOADS_DIR, DATA_DIR } from '../helpers/paths.js';
import pool             from '../db.js';

// ── Prompts ───────────────────────────────────────────────────────────────────

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
- explanation: array of bullet points copied EXACTLY from IMAGE 2. Extract only visible bullets — do NOT add, invent, or infer. Never exceed what is printed.
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

// ── Handlers ──────────────────────────────────────────────────────────────────

// POST /api/ingest/extract — 2 images → Gemini Vision → JSON questions
export async function handleIngestExtract(req, res) {
  try {
    if (!req.files?.questionPage) {
      return res.status(400).json({ error: 'Question page image is required' });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
    }

    const qImg  = req.files.questionPage[0];
    const aImg  = req.files.answerPage?.[0];
    const parts = [
      { inlineData: { data: qImg.buffer.toString('base64'), mimeType: qImg.mimetype } },
    ];

    if (aImg) {
      parts.push({ inlineData: { data: aImg.buffer.toString('base64'), mimeType: aImg.mimetype } });
      parts.push({ text: INGEST_PROMPT_TWO });
    } else {
      parts.push({ text: INGEST_PROMPT_ONE });
    }

    const ai     = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const result = await ai.models.generateContent({
      model:    process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      contents: [{ role: 'user', parts }],
      config:   { temperature: 0.1, maxOutputTokens: 8192 },
    });

    let data;
    try {
      data = parseGeminiJSON(result.text);
    } catch {
      return res.status(500).json({ error: 'Gemini returned unparseable response', raw: result.text.slice(0, 600) });
    }

    if (!Array.isArray(data.questions)) {
      return res.status(500).json({ error: 'Unexpected Gemini response structure', raw: result.text.slice(0, 600) });
    }

    res.json({ success: true, questions: data.questions, page_notes: data.page_notes || '', total: data.questions.length });
  } catch (err) {
    console.error('Ingest extract error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/ingest/save — persist approved questions to data/questions.json
export function handleIngestSave(req, res) {
  try {
    const { questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'No questions provided' });
    }

    const dbPath   = path.join(DATA_DIR, 'questions.json');
    let existing   = [];
    if (fs.existsSync(dbPath)) {
      try { existing = JSON.parse(fs.readFileSync(dbPath, 'utf-8')); } catch {}
    }

    const existingStems = new Set(existing.map(q => (q.stem || '').slice(0, 80).toLowerCase().trim()));
    const saved  = [];
    const dupes  = [];

    for (const q of questions) {
      const key = (q.stem || '').slice(0, 80).toLowerCase().trim();
      if (existingStems.has(key)) {
        dupes.push(q.q_num);
      } else {
        saved.push({
          id:                  `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
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
          topic:               q.topic || null,
          difficulty:          q.difficulty || 'medium',
          has_image:           q.has_image || false,
          image_url:           q.image_url || null,
          image_description:   q.image_description || null,
          tags:                q.tags || [],
          created_at:          new Date().toISOString(),
        });
        existingStems.add(key);
      }
    }

    const updated = [...existing, ...saved];
    fs.writeFileSync(dbPath, JSON.stringify(updated, null, 2));

    res.json({ success: true, saved: saved.length, duplicates: dupes.length, duplicate_nums: dupes, total_in_db: updated.length });
  } catch (err) {
    console.error('Ingest save error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/ingest/upload-image — store a question diagram image to disk
export function handleUploadImage(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const { questionId } = req.body;
    const ext      = path.extname(req.file.originalname).toLowerCase() || '.png';
    const filename = `${questionId || `img_${Date.now()}`}${ext}`;
    const filepath = path.join(UPLOADS_DIR, filename);

    fs.writeFileSync(filepath, req.file.buffer);

    res.json({ success: true, url: `/uploads/questions/${filename}`, filename });
  } catch (err) {
    console.error('Image upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// GET /api/ingest/stats — question bank summary for admin dashboard
export async function handleStats(req, res) {
  try {
    const [totalRes, subjectsRes, imageRes] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS total FROM questions'),
      pool.query('SELECT subject, COUNT(*)::int AS count FROM questions GROUP BY subject ORDER BY count DESC'),
      pool.query('SELECT COUNT(*)::int AS has_image FROM questions WHERE has_image = true'),
    ]);

    const subjects = {};
    subjectsRes.rows.forEach(r => { subjects[r.subject || 'unknown'] = r.count; });

    res.json({ total: totalRes.rows[0].total, subjects, has_image: imageRes.rows[0].has_image });
  } catch {
    res.json({ total: 0, subjects: {}, has_image: 0 });
  }
}
