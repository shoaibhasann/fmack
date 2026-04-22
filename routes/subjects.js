// ─── Subjects & DB Generation Routes ──────────────────────────────────────────
// GET  /api/subjects          — subject list with counts (powers the generator dropdown)
// POST /api/generate-from-db  — DB-only question sets, no AI
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import {
  handleGetSubjects,
  handleGenerateFromDb,
} from '../controllers/subjectsController.js';

const router = Router();
router.get('/subjects',           handleGetSubjects);
router.post('/generate-from-db',  handleGenerateFromDb);

export default router;
