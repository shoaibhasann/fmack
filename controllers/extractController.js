// ─── Extract Controller ────────────────────────────────────────────────────────
// POST /api/extract — accept an uploaded file, return its plain text.
// ─────────────────────────────────────────────────────────────────────────────

import { extractText } from '../helpers/extractText.js';

export async function handleExtract(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const text = await extractText(req.file.buffer, req.file.originalname);

    if (!text || text.trim().length < 20) {
      return res.status(400).json({ error: 'Could not extract readable text from this file' });
    }

    res.json({
      success:   true,
      text:      text.trim(),
      fileName:  req.file.originalname,
      charCount: text.trim().length,
    });
  } catch (err) {
    console.error('Extract error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
