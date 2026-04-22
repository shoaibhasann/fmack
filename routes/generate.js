// ─── Generate Routes ───────────────────────────────────────────────────────────
// POST /api/extract        — upload file → extract plain text
// POST /api/generate       — plain text → SSE stream → 3 AI question sets
// GET  /api/result/:id     — fetch a completed generation result by ID
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import multer     from 'multer';
import path       from 'path';

import { handleExtract }                   from '../controllers/extractController.js';
import { handleGenerate, handleGetResult } from '../controllers/generateController.js';

const router = Router();

// Multer for document uploads (PDF / DOC / DOCX / TXT, max 50 MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    ['.pdf', '.doc', '.docx', '.txt'].includes(ext)
      ? cb(null, true)
      : cb(new Error('Supported: PDF, DOC, DOCX, TXT'));
  },
});

router.post('/extract',    upload.single('file'), handleExtract);
router.post('/generate',   handleGenerate);
router.get('/result/:id',  handleGetResult);

export default router;
