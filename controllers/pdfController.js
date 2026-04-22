// ─── PDF Controller ────────────────────────────────────────────────────────────
// POST /api/pdf — render a question variation to PDF via Puppeteer.
// ─────────────────────────────────────────────────────────────────────────────

import puppeteer      from 'puppeteer';
import { buildPDFHtml } from '../helpers/pdfTemplate.js';

export async function handlePdf(req, res) {
  try {
    const { variation, metadata, pdfSubject } = req.body;
    if (!variation) return res.status(400).json({ error: 'No variation data' });

    const html    = buildPDFHtml(variation, metadata, pdfSubject);
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(120_000);
    page.setDefaultTimeout(120_000);

    // 'load' waits for DOM + scripts but not CDN idle — faster than networkidle0
    await page.setContent(html, { waitUntil: 'load', timeout: 120_000 });
    await new Promise(r => setTimeout(r, 800)); // brief layout settle

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', right: '14mm', bottom: '18mm', left: '14mm' },
    });

    await browser.close();

    const subject = (pdfSubject?.trim() || metadata?.subject || 'FMGE').substring(0, 30);
    const setNum  = variation.variation_id || variation.title.replace(/\D/g, '') || '1';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${subject} SET - ${setNum}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('PDF error:', err.message);
    res.status(500).json({ error: err.message || 'PDF generation failed' });
  }
}
