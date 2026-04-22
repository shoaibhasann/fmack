import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname }       from 'path';
import pool from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const client = await pool.connect();
  console.log('Connected to PostgreSQL');

  // ── Create tables ───────────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS questions (
      id                  TEXT PRIMARY KEY,
      stem                TEXT NOT NULL,
      option_a            TEXT,
      option_b            TEXT,
      option_c            TEXT,
      option_d            TEXT,
      correct_option      TEXT,
      correct_answer_text TEXT,
      explanation         JSONB,
      source              TEXT,
      source_type         TEXT,
      subject             TEXT,
      topic               TEXT,
      difficulty          VARCHAR(10) DEFAULT 'medium',
      has_image           BOOLEAN DEFAULT false,
      image_url           TEXT,
      image_description   TEXT,
      tags                TEXT[],
      gemini_reviewed     BOOLEAN DEFAULT false,
      created_at          TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_subject    ON questions(subject);
    CREATE INDEX IF NOT EXISTS idx_difficulty ON questions(difficulty);
    CREATE INDEX IF NOT EXISTS idx_source     ON questions(source);
    CREATE INDEX IF NOT EXISTS idx_stem_fts   ON questions USING gin(to_tsvector('english', stem));

    CREATE TABLE IF NOT EXISTS review_decisions (
      question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
      decision    VARCHAR(10) NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS pyq_questions (
      id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      exam_type              TEXT NOT NULL,
      year                   SMALLINT NOT NULL,
      session                TEXT,
      source_code            TEXT NOT NULL,
      stem                   TEXT NOT NULL,
      option_a               TEXT NOT NULL,
      option_b               TEXT NOT NULL,
      option_c               TEXT NOT NULL,
      option_d               TEXT NOT NULL,
      correct_option         CHAR(1) NOT NULL,
      question_image_url     TEXT,
      explanation_text       TEXT,
      explanation_image_urls TEXT[],
      subject                TEXT,
      topic                  TEXT,
      difficulty             TEXT DEFAULT 'medium',
      tags                   TEXT[],
      created_by             TEXT DEFAULT 'admin',
      gemini_reviewed        BOOLEAN DEFAULT false,
      created_at             TIMESTAMPTZ DEFAULT now(),
      updated_at             TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_pyq_source_code ON pyq_questions(source_code);
    CREATE INDEX IF NOT EXISTS idx_pyq_exam_year   ON pyq_questions(exam_type, year);
    CREATE INDEX IF NOT EXISTS idx_pyq_subject     ON pyq_questions(subject);
    CREATE INDEX IF NOT EXISTS idx_pyq_stem_fts    ON pyq_questions USING gin(to_tsvector('english', stem));
  `);

  // Widen any VARCHAR columns that may have been created in a previous run
  await client.query(`
    ALTER TABLE IF EXISTS questions
      ALTER COLUMN source      TYPE TEXT,
      ALTER COLUMN source_type TYPE TEXT,
      ALTER COLUMN subject     TYPE TEXT,
      ALTER COLUMN topic       TYPE TEXT;
  `);

  // Add explanation_tables column to pyq_questions (safe to run on existing DB)
  await client.query(`
    ALTER TABLE IF EXISTS pyq_questions
      ADD COLUMN IF NOT EXISTS explanation_tables JSONB;
  `);
  console.log('Tables created');

  // ── Load JSON ───────────────────────────────────────────────────────────────
  const dataPath = path.join(__dirname, 'data', 'questions_premium.json');
  if (!fs.existsSync(dataPath)) {
    console.error('questions_premium.json not found at', dataPath);
    process.exit(1);
  }
  const questions = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  console.log(`Loaded ${questions.length} questions from JSON`);

  // ── Batch insert ────────────────────────────────────────────────────────────
  const BATCH = 500;
  let inserted = 0;

  for (let i = 0; i < questions.length; i += BATCH) {
    const batch = questions.slice(i, i + BATCH);

    const values       = [];
    const placeholders = batch.map((q, j) => {
      const b = j * 19;
      values.push(
        q.id                  || `q_${i + j}`,
        q.stem                || '',
        q.option_a            || null,
        q.option_b            || null,
        q.option_c            || null,
        q.option_d            || null,
        q.correct_option      || null,
        q.correct_answer_text || null,
        JSON.stringify(q.explanation || null),
        q.source              || null,
        q.source_type         || null,
        q.subject             || null,
        q.topic               || null,
        q.difficulty          || 'medium',
        q.has_image           || false,
        q.image_url           || null,
        q.image_description   || null,
        q.tags                || null,
        q.gemini_reviewed     || false
      );
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},$${b+15},$${b+16},$${b+17},$${b+18},$${b+19})`;
    });

    await client.query(`
      INSERT INTO questions
        (id,stem,option_a,option_b,option_c,option_d,correct_option,correct_answer_text,
         explanation,source,source_type,subject,topic,difficulty,has_image,image_url,
         image_description,tags,gemini_reviewed)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (id) DO NOTHING
    `, values);

    inserted += batch.length;
    process.stdout.write(`\r  ${inserted}/${questions.length} migrated`);
  }

  console.log('\nMigration complete!');
  client.release();
  await pool.end();
}

migrate().catch(err => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
