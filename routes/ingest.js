// ─── Ingest Routes ─────────────────────────────────────────────────────────────
// POST /api/ingest/extract       — 2 scanned images → Gemini Vision → JSON questions
// POST /api/ingest/save          — save approved questions to data/questions.json
// POST /api/ingest/upload-image  — save a question diagram image to disk
// GET  /api/ingest/stats         — question bank summary counts
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import multer     from 'multer';
import path       from 'path';

import {
  handleIngestExtract,
  handleIngestSave,
  handleUploadImage,
  handleStats,
} from '../controllers/ingestController.js';

const router = Router();

// Multer for image uploads (JPG / PNG / WEBP, max 15 MB)
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)
      ? cb(null, true)
      : cb(new Error('Images only: JPG, PNG, WEBP'));
  },
});

router.post(
  '/extract',
  imageUpload.fields([{ name: 'questionPage', maxCount: 1 }, { name: 'answerPage', maxCount: 1 }]),
  handleIngestExtract
);
router.post('/save',          handleIngestSave);
router.post('/upload-image',  imageUpload.single('image'), handleUploadImage);
router.get('/stats',          handleStats);

export default router;
