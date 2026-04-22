// ─── Entry Point ───────────────────────────────────────────────────────────────
// Boots the Express app: middleware + route mounting only.
// All business logic lives in controllers/, helpers/, and routes/.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import express    from 'express';
import path       from 'path';
import fs         from 'fs';
import { fileURLToPath } from 'url';
import { dirname }       from 'path';

// ─── Route modules ────────────────────────────────────────────────────────────
import generateRoutes from './routes/generate.js';
import pdfRoutes      from './routes/pdf.js';
import ingestRoutes   from './routes/ingest.js';
import reviewRoutes   from './routes/review.js';
import subjectRoutes  from './routes/subjects.js';
import pyqRoutes      from './routes/pyq.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3003;

// ─── Ensure required directories exist ───────────────────────────────────────
[
  path.join(__dirname, 'uploads', 'questions'),
  path.join(__dirname, 'data'),
  path.join(__dirname, 'temp'),
].forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api',         generateRoutes);   // /api/extract, /api/generate, /api/result/:id
app.use('/api/pdf',     pdfRoutes);        // /api/pdf
app.use('/api/ingest',  ingestRoutes);     // /api/ingest/*
app.use('/api/review',  reviewRoutes);     // /api/review/*
app.use('/api',         subjectRoutes);    // /api/subjects, /api/generate-from-db
app.use('/api/pyq',     pyqRoutes);        // /api/pyq/*

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  FMGE AI Generator running at http://localhost:${PORT}\n`);
});
