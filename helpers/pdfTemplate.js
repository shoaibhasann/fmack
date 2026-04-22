// ─── PDF HTML Template ────────────────────────────────────────────────────────
// Generates the full HTML document that Puppeteer renders into a PDF.
// Kept in one file so all styling + structure stays in sync.
// ─────────────────────────────────────────────────────────────────────────────

// Render an image-prompt hint box (shown when a question has a visual prompt)
export function imagePromptBox(prompt, label) {
  if (!prompt) return '';
  let text;
  if (typeof prompt === 'string') {
    text = prompt;
  } else if (typeof prompt === 'object') {
    text = prompt.text || prompt.description || prompt.prompt ||
           Object.values(prompt).find(v => typeof v === 'string') || '';
  } else {
    text = String(prompt);
  }
  if (!text) return '';
  return `
  <div class="img-prompt-box">
    <div class="img-prompt-label">🖼️ ${label}</div>
    <div class="img-prompt-text">${text}</div>
    <div class="img-prompt-hint">📋 Copy this prompt → paste into ChatGPT / DALL-E / Gemini / Bing Image Creator to generate the diagram</div>
  </div>`;
}

// Render a comparison table from the structured table object
export function tableHTML(tbl) {
  if (!tbl || !tbl.headers || !tbl.rows) return '';
  const caption = tbl.caption ? `<caption>${tbl.caption}</caption>` : '';
  const headers = tbl.headers.map(h => `<th>${h}</th>`).join('');
  const rows    = tbl.rows.map(row =>
    `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`
  ).join('');
  return `
  <div class="exp-block">
    <h4>Comparison Table</h4>
    <table class="exp-table">${caption}<thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

// Build the complete HTML document for one variation (Easy / Medium / Hard)
export function buildPDFHtml(variation, metadata, pdfSubject) {
  const subject = (pdfSubject && pdfSubject.trim()) || metadata?.subject || 'FMGE';

  const questionsHTML = variation.questions.map((q, idx) => {
    const exp     = q.explanation || {};
    const opts    = q.options     || {};
    const correct = q.correct_answer;

    const optionsHTML = Object.entries(opts).map(([k, v]) => `
      <div class="option ${k === correct ? 'correct' : ''}">
        <span class="opt-key">${k}</span>
        <span class="opt-text">${v || ''}</span>
        ${k === correct ? '<span class="tick">✓ Correct Answer</span>' : ''}
      </div>`).join('');

    const toArr      = v => Array.isArray(v) ? v : (v ? [v] : []);
    const keyPtsHTML = toArr(exp.key_points).map(p => `<li>${p}</li>`).join('');

    // Build hashtag pills — strip noise tags that have no exam relevance
    const NOISE_TAGS = new Set(['medmcqa', 'practice', 'train', 'med', 'mcqa']);
    const tagSet = new Set();
    if (q.subject) tagSet.add(q.subject.trim());
    if (q.topic)   tagSet.add(q.topic.trim());
    toArr(q.tags).forEach(t => {
      const clean = (t || '').trim().toLowerCase();
      if (clean && !NOISE_TAGS.has(clean)) tagSet.add(t.trim());
    });
    const tagsHTML = [...tagSet].map(t => `<span class="tag-pill">#${t}</span>`).join('');

    return `
    <div class="q-card">
      <div class="q-head">
        <span class="q-badge">Q${idx + 1}</span>
        <p class="q-text">${q.question || ''}</p>
      </div>

      ${imagePromptBox(q.question_image_prompt, 'Image Prompt for this Question')}

      <div class="q-opts">${optionsHTML}</div>

      <div class="q-exp">
        <div class="exp-block">
          <h4>Clinical Overview</h4>
          <p>${exp.overview || ''}</p>
        </div>
        <div class="exp-block">
          <h4>Detailed Explanation</h4>
          <p>${exp.detailed || ''}</p>
        </div>
        ${tableHTML(exp.table)}

        ${keyPtsHTML ? `
        <div class="exp-block key-pts">
          <h4>⭐ High-Yield Exam Points</h4>
          <ul>${keyPtsHTML}</ul>
        </div>` : ''}
        ${tagsHTML ? `
        <div class="exp-block tags-block">
          <h4>🏷️ Tags</h4>
          <div class="tags-row">${tagsHTML}</div>
        </div>` : ''}
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>FMGE ${variation.title}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#fff;color:#1a1a2e;font-size:10.5pt;line-height:1.65}

  /* Inline page header */
  .pg-head{
    background:linear-gradient(135deg,#0f3460 0%,#16213e 100%);
    color:#fff;padding:18px 22px;border-radius:8px;margin-bottom:18px;
    display:flex;align-items:center;justify-content:space-between;gap:16px
  }
  .pg-head-left h1{font-size:13pt;font-weight:800;letter-spacing:-0.3px;margin-bottom:2px}
  .pg-head-left p{font-size:8.5pt;color:#adb5bd}
  .pg-head-right{text-align:right}
  .pg-head-right .pill{
    display:inline-block;background:#48cae4;color:#0f3460;
    padding:4px 14px;border-radius:20px;font-size:9pt;font-weight:700
  }
  .pg-head-right .meta{font-size:8.5pt;color:#adb5bd;margin-top:4px}

  /* Question card */
  .q-card{border:1px solid #dee2e6;border-radius:8px;overflow:visible;margin-bottom:22px}

  .q-head{background:#f1f3f9;padding:14px 18px;border-bottom:3px solid #0f3460;display:flex;align-items:flex-start;gap:12px}
  .q-badge{background:#0f3460;color:#fff;padding:4px 10px;border-radius:4px;font-weight:700;font-size:10pt;white-space:nowrap;flex-shrink:0}
  .q-text{font-size:11pt;font-weight:600;color:#1a1a2e;flex:1}

  /* Options */
  .q-opts{padding:10px 18px 6px;background:#fff}
  .option{display:flex;align-items:center;padding:7px 12px;margin:5px 0;border-radius:5px;border:1px solid #e9ecef;font-size:10.5pt}
  .option.correct{background:#d4edda;border:2px solid #28a745}
  .opt-key{font-weight:700;color:#0f3460;min-width:22px}
  .option.correct .opt-key{color:#155724}
  .tick{margin-left:auto;background:#28a745;color:#fff;padding:2px 8px;border-radius:4px;font-size:8.5pt;font-weight:700;white-space:nowrap}

  /* Explanation */
  .q-exp{background:#fafbfc;border-top:1px solid #dee2e6;padding:18px}
  .exp-block{margin-bottom:16px}
  .exp-block h4{font-size:9.5pt;font-weight:700;color:#0f3460;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:7px;padding-bottom:4px;border-bottom:1px solid #e9ecef}
  .exp-block p{font-size:10pt;color:#2d3436;line-height:1.7}
  .exp-block ul{margin-left:18px;font-size:10pt;color:#2d3436}
  .exp-block li{margin-bottom:4px}
  .key-pts li::marker{color:#0f3460;font-weight:700}

  /* Tags */
  .tags-block{margin-bottom:0}
  .tags-row{display:flex;flex-wrap:wrap;gap:6px;padding-top:2px}
  .tag-pill{display:inline-block;background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:99px;font-size:8.5pt;font-weight:600;padding:2px 10px;line-height:1.6;letter-spacing:0.2px}

  /* Comparison table */
  .exp-table{width:100%;border-collapse:collapse;font-size:9.5pt;margin-top:8px}
  .exp-table caption{font-size:9pt;color:#555;font-style:italic;margin-bottom:6px;text-align:left}
  .exp-table th{background:#0f3460;color:#fff;padding:7px 10px;text-align:left;font-weight:600}
  .exp-table td{padding:6px 10px;border:1px solid #dee2e6;vertical-align:top}
  .exp-table tr:nth-child(even) td{background:#f8f9fa}

  /* Image prompt box */
  .img-prompt-box{background:#fffbeb;border:1.5px dashed #f59e0b;border-radius:8px;padding:12px 16px;margin:10px 18px}
  .img-prompt-label{font-size:9pt;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px}
  .img-prompt-text{font-size:10pt;color:#451a03;line-height:1.6;font-style:italic}
  .img-prompt-hint{font-size:8.5pt;color:#b45309;margin-top:6px;padding-top:6px;border-top:1px dotted #f59e0b}
</style>
</head>
<body>

<div class="pg-head">
  <div class="pg-head-left">
    <h1>A.J Medical Academy &nbsp;·&nbsp; FMGE Question Bank</h1>
    <p>Subject: ${subject} &nbsp;|&nbsp; ${variation.title}</p>
  </div>
  <div class="pg-head-right">
    <span class="pill">${variation.questions.length} Questions</span>
    <div class="meta">${subject}</div>
  </div>
</div>

${questionsHTML}

</body>
</html>`;
}
