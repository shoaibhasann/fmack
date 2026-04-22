// ─── Schema Migration — question_banks unified table ─────────────────────────
// Safe / additive only. Never touches the existing `questions` or
// `pyq_questions` tables. Drops and recreates only the empty metadata
// `question_banks` table that was created in the previous run.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import pool from './db.js';

async function migrateSchema() {
  const client = await pool.connect();
  console.log('Connected to PostgreSQL\n');

  // ── 1. Drop the empty metadata table from the previous migration run ───────
  console.log('Step 1/4 — Removing old metadata question_banks table...');
  await client.query(`DROP TABLE IF EXISTS question_banks;`);
  console.log('  ✓ Dropped (was empty metadata table, no data lost)');

  // ── 2. Create the real question_banks questions table ─────────────────────
  // This is the single unified table for all future questions.
  // Differentiation is done via: subscription_type + exam_type + exam_source + tags
  console.log('Step 2/4 — Creating question_banks table...');
  await client.query(`
    CREATE TABLE IF NOT EXISTS question_banks (
      id                     UUID    PRIMARY KEY DEFAULT gen_random_uuid(),

      -- ── Classification (how questions are routed / filtered) ──────────────
      subscription_type      TEXT    NOT NULL DEFAULT 'free',
        -- 'free' | 'premium' | 'pro'  — controls access tier
      exam_type              TEXT    NOT NULL DEFAULT 'CUSTOM',
        -- 'FMGE' | 'NEET_PG' | 'CUSTOM' — exam category
      exam_source            TEXT    NOT NULL,
        -- source_code: e.g. 'fmge_june_2025', 'neet_pg_2024', custom values
      year                   SMALLINT,
      session                TEXT,

      -- ── Question content ──────────────────────────────────────────────────
      stem                   TEXT    NOT NULL,
      option_a               TEXT    NOT NULL,
      option_b               TEXT    NOT NULL,
      option_c               TEXT    NOT NULL,
      option_d               TEXT    NOT NULL,
      correct_option         CHAR(1) NOT NULL,  -- 'a' | 'b' | 'c' | 'd'

      -- ── Media ─────────────────────────────────────────────────────────────
      question_image_url     TEXT,

      -- ── Explanation ───────────────────────────────────────────────────────
      explanation_text       TEXT,
      explanation_image_urls TEXT[],
      explanation_tables     JSONB,   -- [{headers:[...], rows:[[...]]}]

      -- ── Metadata ──────────────────────────────────────────────────────────
      subject                TEXT,
      topic                  TEXT,
      difficulty             TEXT    NOT NULL DEFAULT 'medium',
      tags                   TEXT[],

      -- ── Admin ─────────────────────────────────────────────────────────────
      created_by             TEXT    DEFAULT 'admin',
      gemini_reviewed        BOOLEAN DEFAULT false,
      created_at             TIMESTAMPTZ DEFAULT now(),
      updated_at             TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('  ✓ question_banks table created');

  // ── 3. Indexes ─────────────────────────────────────────────────────────────
  console.log('Step 3/4 — Creating indexes...');
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_qb_exam_type        ON question_banks(exam_type);
    CREATE INDEX IF NOT EXISTS idx_qb_exam_source      ON question_banks(exam_source);
    CREATE INDEX IF NOT EXISTS idx_qb_subscription     ON question_banks(subscription_type);
    CREATE INDEX IF NOT EXISTS idx_qb_subject          ON question_banks(subject);
    CREATE INDEX IF NOT EXISTS idx_qb_difficulty       ON question_banks(difficulty);
    CREATE INDEX IF NOT EXISTS idx_qb_exam_year        ON question_banks(exam_type, year);
    CREATE INDEX IF NOT EXISTS idx_qb_tags             ON question_banks USING gin(tags);
    CREATE INDEX IF NOT EXISTS idx_qb_stem_fts         ON question_banks
      USING gin(to_tsvector('english', stem));
  `);
  console.log('  ✓ Indexes created');

  // ── 4. Verify existing tables untouched ────────────────────────────────────
  console.log('Step 4/4 — Verifying existing tables are untouched...');
  const { rows } = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM questions)     AS premium_count,
      (SELECT COUNT(*) FROM pyq_questions) AS pyq_count,
      (SELECT COUNT(*) FROM question_banks) AS new_bank_count;
  `);
  console.log(`  ✓ questions (premium): ${rows[0].premium_count} rows — untouched`);
  console.log(`  ✓ pyq_questions:       ${rows[0].pyq_count} rows — untouched`);
  console.log(`  ✓ question_banks:      ${rows[0].new_bank_count} rows — new empty table`);

  console.log('\n═══════════════════════════════════════════════════');
  console.log('Migration complete.');
  console.log('All new questions will now save to question_banks.');
  console.log('═══════════════════════════════════════════════════\n');

  client.release();
  await pool.end();
}

migrateSchema().catch(err => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
