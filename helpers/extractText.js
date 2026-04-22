// ─── Text Extraction Helper ───────────────────────────────────────────────────
// Extracts raw text from uploaded documents (PDF, DOCX, DOC, TXT).
// Used by the file-upload → AI generation flow.
// ─────────────────────────────────────────────────────────────────────────────

import pdfParse     from 'pdf-parse';
import mammoth      from 'mammoth';
import WordExtractor from 'word-extractor';
import path          from 'path';

// Extract plain text from a file buffer based on its extension
export async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.pdf') {
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === '.doc') {
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);
    return doc.getBody();
  }

  if (ext === '.txt') {
    return buffer.toString('utf-8');
  }

  throw new Error('Unsupported file format');
}

// Return the Gemini model name from env (falls back to lite preview)
export function getModel() {
  return process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite-preview-06-17';
}
