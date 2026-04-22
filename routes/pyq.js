// ─── PYQ Routes — question_banks table ───────────────────────────────────────
// All endpoints under /api/pyq
//
// GET    /api/pyq/sources            → distinct exam_source list + counts
// GET    /api/pyq/questions          → paginated list (filterable)
// GET    /api/pyq/questions/:id      → single question
// POST   /api/pyq/questions          → create question  → question_banks
// PUT    /api/pyq/questions/:id      → update question
// DELETE /api/pyq/questions/:id      → delete question + R2 cleanup
// POST   /api/pyq/upload-image       → upload image to R2, returns URL
// ─────────────────────────────────────────────────────────────────────────────

import { Router }    from 'express';
import multer        from 'multer';
import path          from 'path';
import pool          from '../db.js';
import { EXAM_SOURCES, SUBJECTS } from '../config/examSources.js';
import { uploadToR2, deleteFromR2, isR2Configured } from '../services/r2.js';

const router = Router();

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)
      ? cb(null, true)
      : cb(new Error('Images only: JPG, PNG, WEBP'));
  },
});

// ── GET /api/pyq/sources ──────────────────────────────────────────────────────
// Returns all distinct exam_source values from question_banks + counts,
// plus predefined EXAM_SOURCES merged in, plus subjects list.
router.get('/sources', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        exam_source,
        exam_type,
        subscription_type,
        COUNT(*)::int AS count
      FROM question_banks
      GROUP BY exam_source, exam_type, subscription_type
      ORDER BY exam_type, exam_source
    `);

    // Merge predefined labels with live DB counts
    const countMap = Object.fromEntries(rows.map(r => [r.exam_source, r.count]));
    const predefined = EXAM_SOURCES.map(s => ({
      source_code:       s.source_code,
      label:             s.label,
      exam_type:         s.exam_type,
      year:              s.year,
      session:           s.session,
      subscription_type: 'free',
      count:             countMap[s.source_code] || 0,
    }));

    // Also include any custom / DB-only sources not in EXAM_SOURCES list
    const predefinedCodes = new Set(EXAM_SOURCES.map(s => s.source_code));
    const custom = rows
      .filter(r => !predefinedCodes.has(r.exam_source))
      .map(r => ({
        source_code:       r.exam_source,
        label:             r.exam_source,
        exam_type:         r.exam_type,
        subscription_type: r.subscription_type,
        count:             r.count,
      }));

    const sources = [...predefined, ...custom];

    // Stats per exam type
    const stats = await pool.query(`
      SELECT
        exam_type,
        subscription_type,
        COUNT(*)::int AS count
      FROM question_banks
      GROUP BY exam_type, subscription_type
    `);

    res.json({
      sources,
      subjects:       SUBJECTS,
      r2_configured:  isR2Configured(),
      stats:          stats.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/pyq/questions ────────────────────────────────────────────────────
router.get('/questions', async (req, res) => {
  try {
    const {
      exam_source, exam_type, subject, difficulty,
      subscription_type, search,
    } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(10, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const conditions = [];
    const params     = [];

    if (exam_source)       { params.push(exam_source);       conditions.push(`exam_source       = $${params.length}`); }
    if (exam_type)         { params.push(exam_type);         conditions.push(`exam_type         = $${params.length}`); }
    if (subject)           { params.push(subject);           conditions.push(`subject           = $${params.length}`); }
    if (difficulty)        { params.push(difficulty);        conditions.push(`difficulty        = $${params.length}`); }
    if (subscription_type) { params.push(subscription_type); conditions.push(`subscription_type = $${params.length}`); }
    if (search)            { params.push(`%${search}%`);     conditions.push(`stem ILIKE        $${params.length}`);   }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `SELECT * FROM question_banks ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM question_banks ${where}`,
        params
      ),
    ]);

    res.json({
      questions: rowsRes.rows,
      total:     countRes.rows[0].total,
      page,
      pages: Math.ceil(countRes.rows[0].total / limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/pyq/questions/:id ────────────────────────────────────────────────
router.get('/questions/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM question_banks WHERE id = $1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Question not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/pyq/questions ───────────────────────────────────────────────────
router.post('/questions', async (req, res) => {
  try {
    const {
      source_code,      // exam_source value
      custom_source,    // {exam_type, year, session, label} when not in EXAM_SOURCES
      subscription_type,
      stem, option_a, option_b, option_c, option_d, correct_option,
      question_image_url,
      explanation_text, explanation_image_urls, explanation_tables,
      subject, topic, difficulty, tags,
      created_by,
    } = req.body;

    if (!source_code)
      return res.status(400).json({ error: 'source_code is required' });
    if (!stem)
      return res.status(400).json({ error: 'stem is required' });
    if (!option_a || !option_b || !option_c || !option_d)
      return res.status(400).json({ error: 'All four options are required' });
    if (!correct_option || !['a','b','c','d'].includes(correct_option.toLowerCase()))
      return res.status(400).json({ error: 'correct_option must be a, b, c, or d' });

    // Resolve exam metadata from predefined list or custom_source
    let examMeta;
    const predefined = EXAM_SOURCES.find(s => s.source_code === source_code);
    if (predefined) {
      examMeta = { exam_type: predefined.exam_type, year: predefined.year, session: predefined.session };
    } else if (custom_source?.exam_type && custom_source?.year) {
      examMeta = { exam_type: custom_source.exam_type, year: custom_source.year, session: custom_source.session || null };
    } else {
      return res.status(400).json({
        error: `Unknown source_code "${source_code}". Use custom_source with exam_type and year for new sources.`,
      });
    }

    const { rows } = await pool.query(`
      INSERT INTO question_banks (
        exam_type, year, session, exam_source,
        subscription_type,
        stem, option_a, option_b, option_c, option_d, correct_option,
        question_image_url,
        explanation_text, explanation_image_urls, explanation_tables,
        subject, topic, difficulty, tags, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING *`,
      [
        examMeta.exam_type, examMeta.year, examMeta.session, source_code,
        subscription_type || 'free',
        stem.trim(),
        option_a.trim(), option_b.trim(), option_c.trim(), option_d.trim(),
        correct_option.toLowerCase(),
        question_image_url     || null,
        explanation_text       || null,
        explanation_image_urls || null,
        explanation_tables     ? JSON.stringify(explanation_tables) : null,
        subject    || null,
        topic      || null,
        difficulty || 'medium',
        tags       || null,
        created_by || 'admin',
      ]
    );

    res.status(201).json({ success: true, question: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/pyq/questions/:id ────────────────────────────────────────────────
router.put('/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await pool.query('SELECT * FROM question_banks WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Question not found' });
    const old = existing.rows[0];

    const {
      source_code, custom_source, subscription_type,
      stem, option_a, option_b, option_c, option_d, correct_option,
      question_image_url, explanation_text, explanation_image_urls, explanation_tables,
      subject, topic, difficulty, tags,
    } = req.body;

    // Delete old R2 image if question image changed
    if (question_image_url !== undefined && old.question_image_url && old.question_image_url !== question_image_url) {
      await deleteFromR2(old.question_image_url).catch(() => {});
    }

    // Re-resolve exam metadata if source changed
    let examMeta = { exam_type: old.exam_type, year: old.year, session: old.session };
    if (source_code && source_code !== old.exam_source) {
      const src = EXAM_SOURCES.find(s => s.source_code === source_code);
      if (src) {
        examMeta = { exam_type: src.exam_type, year: src.year, session: src.session };
      } else if (custom_source?.exam_type && custom_source?.year) {
        examMeta = { exam_type: custom_source.exam_type, year: custom_source.year, session: custom_source.session || null };
      } else {
        return res.status(400).json({ error: `Unknown source_code "${source_code}". Provide custom_source.` });
      }
    }

    const { rows } = await pool.query(`
      UPDATE question_banks SET
        exam_type         = $1,  year              = $2,  session           = $3,
        exam_source       = $4,  subscription_type = $5,  stem              = $6,
        option_a          = $7,  option_b          = $8,  option_c          = $9,
        option_d          = $10, correct_option    = $11,
        question_image_url     = $12,
        explanation_text       = $13,
        explanation_image_urls = $14,
        explanation_tables     = $15,
        subject    = $16, topic      = $17, difficulty = $18,
        tags       = $19, updated_at = now()
      WHERE id = $20
      RETURNING *`,
      [
        examMeta.exam_type, examMeta.year, examMeta.session,
        source_code               ?? old.exam_source,
        subscription_type         ?? old.subscription_type,
        stem         ? stem.trim()         : old.stem,
        option_a     ? option_a.trim()     : old.option_a,
        option_b     ? option_b.trim()     : old.option_b,
        option_c     ? option_c.trim()     : old.option_c,
        option_d     ? option_d.trim()     : old.option_d,
        correct_option ? correct_option.toLowerCase() : old.correct_option,
        question_image_url     !== undefined ? question_image_url     : old.question_image_url,
        explanation_text       !== undefined ? explanation_text       : old.explanation_text,
        explanation_image_urls !== undefined ? explanation_image_urls : old.explanation_image_urls,
        explanation_tables     !== undefined
          ? (explanation_tables ? JSON.stringify(explanation_tables) : null)
          : old.explanation_tables,
        subject    !== undefined ? subject    : old.subject,
        topic      !== undefined ? topic      : old.topic,
        difficulty !== undefined ? difficulty : old.difficulty,
        tags       !== undefined ? tags       : old.tags,
        id,
      ]
    );

    res.json({ success: true, question: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/pyq/questions/:id ─────────────────────────────────────────────
router.delete('/questions/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM question_banks WHERE id = $1 RETURNING *', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Question not found' });

    const q = rows[0];
    const imagesToDelete = [
      q.question_image_url,
      ...(q.explanation_image_urls || []),
    ].filter(Boolean);
    await Promise.allSettled(imagesToDelete.map(url => deleteFromR2(url)));

    res.json({ success: true, deleted: q.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/pyq/upload-image ────────────────────────────────────────────────
router.post('/upload-image', imageUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    if (!isR2Configured()) {
      return res.status(503).json({
        error: 'Image upload not configured. Add R2_* variables to .env first.',
      });
    }
    const folder = req.query.folder === 'explanations' ? 'pyq/explanations' : 'pyq/questions';
    const url    = await uploadToR2(req.file.buffer, folder, req.file.originalname, req.file.mimetype);
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
