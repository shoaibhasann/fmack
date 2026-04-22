// ─── Review Routes ─────────────────────────────────────────────────────────────
// GET  /api/review/questions — paginated questions with review state
// POST /api/review/save       — save kept / rejected decisions
// POST /api/review/difficulty — batch-update question difficulty
// POST /api/review/apply      — delete all non-kept questions
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import {
  handleQuestions,
  handleSave,
  handleDifficulty,
  handleApply,
} from '../controllers/reviewController.js';

const router = Router();
router.get('/questions', handleQuestions);
router.post('/save',       handleSave);
router.post('/difficulty', handleDifficulty);
router.post('/apply',      handleApply);

export default router;
