// ─── Review Controller ─────────────────────────────────────────────────────────
// Handles the question review workflow: mark questions as kept/rejected,
// batch-update difficulty, and apply the review (purge rejected questions).
//
// GET  /api/review/questions — paginated list with filters + decision state
// POST /api/review/save       — upsert kept/rejected decisions
// POST /api/review/difficulty — batch-update difficulty for a set of questions
// POST /api/review/apply      — delete all questions NOT explicitly marked 'kept'
// ─────────────────────────────────────────────────────────────────────────────

import pool from '../db.js';

// GET /api/review/questions
export async function handleQuestions(req, res) {
  try {
    const subject    = req.query.subject    || '';
    const difficulty = req.query.difficulty || '';
    const search     = req.query.search     || '';
    const page       = Math.max(1,   parseInt(req.query.page)  || 1);
    const limit      = Math.min(100, Math.max(10, parseInt(req.query.limit) || 50));
    const offset     = (page - 1) * limit;

    const conditions = [];
    const params     = [];
    
    if (subject)    { params.push(subject);       conditions.push(`q.subject    = $${params.length}`); }
    if (difficulty) { params.push(difficulty);    conditions.push(`q.difficulty = $${params.length}`); }
    if (search)     { params.push(`%${search}%`); conditions.push(`q.stem ILIKE $${params.length}`);   }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [rowsRes, countRes, subjectsRes, diffRes, summaryRes, totalAllRes] = await Promise.all([
      pool.query(
        `SELECT q.*, rd.decision FROM questions q
         LEFT JOIN review_decisions rd ON q.id = rd.question_id
         ${where} ORDER BY q.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM questions q ${where}`, params),
      pool.query('SELECT subject, COUNT(*)::int AS count FROM questions GROUP BY subject ORDER BY count DESC'),
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE difficulty='easy')::int   AS easy,
        COUNT(*) FILTER (WHERE difficulty='medium')::int AS medium,
        COUNT(*) FILTER (WHERE difficulty='hard')::int   AS hard
        FROM questions`),
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE decision='kept')::int     AS kept,
        COUNT(*) FILTER (WHERE decision='rejected')::int AS rejected
        FROM review_decisions`),
      pool.query('SELECT COUNT(*)::int AS t FROM questions'),
    ]);

    const total    = countRes.rows[0].total;
    const totalAll = totalAllRes.rows[0].t;

    const decisions = {};
    rowsRes.rows.forEach(q => { if (q.decision) decisions[q.id] = q.decision; });
    const questions = rowsRes.rows.map(({ decision, ...q }) => q);
    const { kept = 0, rejected = 0 } = summaryRes.rows[0];

    res.json({
      questions,
      decisions,
      total,
      page,
      pages: Math.ceil(total / limit),
      subjects: subjectsRes.rows.map(r => ({ subject: r.subject || 'unknown', count: r.count })),
      difficulty_counts: {
        easy:   diffRes.rows[0].easy,
        medium: diffRes.rows[0].medium,
        hard:   diffRes.rows[0].hard,
      },
      summary: { total: totalAll, kept, rejected, pending: totalAll - kept - rejected },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/review/save
export async function handleSave(req, res) {
  try {
    const { decisions } = req.body;
    if (!decisions || typeof decisions !== 'object')
      return res.status(400).json({ error: 'decisions object required' });

    const entries = Object.entries(decisions).filter(([, v]) => v === 'kept' || v === 'rejected');
    if (entries.length === 0) return res.json({ success: true, kept: 0, rejected: 0, total: 0 });

    const values       = [];
    const placeholders = entries.map(([id, decision], i) => {
      values.push(id, decision);
      return `($${i * 2 + 1}, $${i * 2 + 2}, now())`;
    });

    await pool.query(`
      INSERT INTO review_decisions (question_id, decision, updated_at)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (question_id) DO UPDATE SET decision = EXCLUDED.decision, updated_at = now()
    `, values);

    const summaryRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE decision='kept')::int     AS kept,
        COUNT(*) FILTER (WHERE decision='rejected')::int AS rejected,
        COUNT(*)::int AS total
      FROM review_decisions
    `);

    const { kept, rejected, total } = summaryRes.rows[0];
    res.json({ success: true, kept, rejected, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/review/difficulty
export async function handleDifficulty(req, res) {
  try {
    const { changes } = req.body;
    if (!changes || typeof changes !== 'object')
      return res.status(400).json({ error: 'changes object required' });

    const entries = Object.entries(changes);
    if (entries.length === 0) return res.json({ success: true, updated: 0 });

    const ids          = entries.map(([id]) => id);
    const cases        = entries.map((_e, i) => `WHEN $${i * 2 + 1} THEN $${i * 2 + 2}`).join(' ');
    const caseValues   = entries.flatMap(([id, diff]) => [id, diff]);
    const idPlaceholders = ids.map((_, i) => `$${caseValues.length + i + 1}`).join(',');

    const result = await pool.query(
      `UPDATE questions SET difficulty = CASE id ${cases} END WHERE id IN (${idPlaceholders})`,
      [...caseValues, ...ids]
    );
    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/review/apply
export async function handleApply(_req, res) {
  try {
    const totalRes   = await pool.query('SELECT COUNT(*)::int AS total FROM questions');
    const total      = totalRes.rows[0].total;
    const keptRes    = await pool.query(`SELECT COUNT(*)::int AS kept FROM review_decisions WHERE decision = 'kept'`);
    const keptCount  = keptRes.rows[0].kept;
    const deleteRes  = await pool.query(`
      DELETE FROM questions
      WHERE id NOT IN (SELECT question_id FROM review_decisions WHERE decision = 'kept')
    `);
    res.json({ success: true, original: total, kept: keptCount, removed: deleteRes.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
