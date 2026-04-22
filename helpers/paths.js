// ─── Shared File-System Paths ─────────────────────────────────────────────────
// Single source of truth for directories used across controllers.
// Import these instead of recomputing __dirname in every file.
// ─────────────────────────────────────────────────────────────────────────────

import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import fs from 'fs';

// Project root (one level up from helpers/)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const UPLOADS_DIR = join(ROOT, 'uploads', 'questions');
export const DATA_DIR    = join(ROOT, 'data');
export const TEMP_DIR    = join(ROOT, 'temp');

// Ensure all directories exist at startup
[UPLOADS_DIR, DATA_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
