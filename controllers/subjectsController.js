// ─── Subjects & DB Generation Controller ──────────────────────────────────────
// GET  /api/subjects          — subject list with question counts (drives the UI dropdown)
// POST /api/generate-from-db  — query Easy/Medium/Hard questions from DB → instant PDF sets
// ─────────────────────────────────────────────────────────────────────────────

import pool              from '../db.js';
import { storeResult }   from '../helpers/resultStore.js';
import { dbQToPdf }      from '../helpers/dbTransform.js';

// GET /api/subjects
export async function handleGetSubjects(_req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT subject, COUNT(*)::int AS count
       FROM questions
       WHERE subject IS NOT NULL
       GROUP BY subject
       ORDER BY count DESC`
    );
    res.json({ subjects: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/generate-from-db
// No AI — fetches Easy / Medium / Hard questions directly from DB.
// Body: { subject: string, count: number (1-200) }
export async function handleGenerateFromDb(req, res) {
  try {
    const { subject, count = 50 } = req.body;
    if (!subject) return res.status(400).json({ error: 'subject is required' });

    const limit = Math.min(Math.max(1, parseInt(count) || 50), 200);

    // Fetch all three difficulty levels in parallel
    const [easyRes, mediumRes, hardRes] = await Promise.all([
      pool.query(`SELECT * FROM questions WHERE subject=$1 AND difficulty='easy'   ORDER BY RANDOM() LIMIT $2`, [subject, limit]),
      pool.query(`SELECT * FROM questions WHERE subject=$1 AND difficulty='medium' ORDER BY RANDOM() LIMIT $2`, [subject, limit]),
      pool.query(`SELECT * FROM questions WHERE subject=$1 AND difficulty='hard'   ORDER BY RANDOM() LIMIT $2`, [subject, limit]),
    ]);

    // Fall back to any difficulty when a specific level has no questions
    const fallback = async (rows) => {
      if (rows.length) return rows;
      const { rows: fb } = await pool.query(
        `SELECT * FROM questions WHERE subject=$1 ORDER BY RANDOM() LIMIT $2`, [subject, limit]
      );
      return fb;
    };

    const [easy, medium, hard] = await Promise.all([
      fallback(easyRes.rows),
      fallback(mediumRes.rows),
      fallback(hardRes.rows),
    ]);

    if (!easy.length && !medium.length && !hard.length) {
      return res.status(404).json({ error: `No questions found for subject: ${subject}` });
    }

    const variations = [
      { variation_id: 1, title: 'Easy',   questions: easy.map(dbQToPdf)   },
      { variation_id: 2, title: 'Medium', questions: medium.map(dbQToPdf) },
      { variation_id: 3, title: 'Hard',   questions: hard.map(dbQToPdf)   },
    ];

    const resultId = storeResult({
      metadata:   { total_questions: Math.max(easy.length, medium.length, hard.length), subject },
      variations,
    });

    res.json({
      success: true,
      id:      resultId,
      subject,
      counts:  variations.map(v => ({ title: v.title, count: v.questions.length })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
