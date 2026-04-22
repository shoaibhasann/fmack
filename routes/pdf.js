// ─── PDF Routes ────────────────────────────────────────────────────────────────
// POST /api/pdf — render a question variation to a downloadable PDF
// ─────────────────────────────────────────────────────────────────────────────

import { Router }    from 'express';
import { handlePdf } from '../controllers/pdfController.js';

const router = Router();
router.post('/', handlePdf);

export default router;
