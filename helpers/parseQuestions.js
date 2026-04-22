// ─── Question Text Parser ─────────────────────────────────────────────────────
// Splits raw text (from uploaded files) into individual question strings.
// Tries four strategies in order and picks the one that found the most questions.
// ─────────────────────────────────────────────────────────────────────────────

export function parseQuestionsFromText(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ── Strategy A: paragraph-per-option (4+ blank lines between questions) ──────
  const paraBlocks = normalized.split(/\n{4,}/)
    .map(b => b.trim())
    .filter(b => b.split(/\n{2,}/).length >= 4 && b.length > 15);

  // ── Strategy B: compact-line style (options on consecutive lines) ─────────────
  const compactBlocks = normalized.split(/\n{2,}/)
    .map(b => b.trim())
    .filter(b => b.split('\n').length >= 3 && b.length > 15);

  // ── Strategy C: numbered-question patterns (1. / 1) style) ───────────────────
  const numCandidates = [
    { pattern: /\n(?=\d{1,3}\.\s)/,           numRe: /^\d{1,3}\.\s/ },
    { pattern: /\n\s*(?=\d{1,3}\.\s)/,        numRe: /^\d{1,3}\.\s/ },
    { pattern: /\n\s*(?=\d{1,3}\)\s)/,        numRe: /^\d{1,3}\)\s/ },
    { pattern: /(?<!\d)(?=\d{1,3}\.\s[A-Z])/, numRe: /^\d{1,3}\.\s/ },
  ];
  let numBest = [];
  for (const { pattern, numRe } of numCandidates) {
    const parts = normalized.split(pattern);
    const qs = parts.map(p => p.trim()).filter(p => numRe.test(p) && p.length > 10);
    if (qs.length > numBest.length) numBest = qs;
  }

  // ── Strategy D: content-aware grouping (clinical vignette heuristics) ─────────
  // Detects question boundaries by content patterns — handles unnumbered MCQs.
  const isNewQuestion = p => {
    if (p.length < 20) return false;
    const n       = p.replace(/\s+/g, ' ');
    const stripped = n.replace(/^[\d\W]+/, '');
    const tp      = stripped.length > 5 ? stripped : n;
    return (
      /\b\d+[\s-]?year[\s-]?old\b/i.test(n) ||
      /\b\d+\s*y[\s/]o\b/i.test(n) ||
      /\b(presents?|presented|brought|admitted|referred|complains?|reports?)\b/i.test(n) ||
      /^(which|what|how|where|identify|select|name|choose)\b/i.test(tp) ||
      /\bof the following\b/i.test(n) ||
      /\ball (are|of the following|except)\b/i.test(n) ||
      /\b(true|false) (about|statement|regarding)\b/i.test(n) ||
      /\b(most common|drug of choice|investigation of choice)\b/i.test(n) ||
      /\b(not true|not seen|not a feature|not associated|except)\b/i.test(n) ||
      (n.endsWith(':') && n.length >= 35) ||
      (n.endsWith('?') && n.length >= 25) ||
      /\b(lesions? of|associated with|characterized by|defined as|known as|defect of|disturbance of|disturbance in|used for|seen in|found in|occurs in|indicated in|caused by)\s*$/i.test(n) ||
      /^the following\b/i.test(n) ||
      (/^(the |a |an )/i.test(n) && n.length > 60)
    );
  };

  const rawParas = normalized.split(/\n{2,}/)
    .map(p => p.replace(/\n/g, ' ').trim())
    .filter(p => p.length > 5);

  const contentGroups = [];
  let cur = [];
  for (const p of rawParas) {
    if (cur.length === 0) {
      cur.push(p);
    } else if (isNewQuestion(p) && cur.length >= 3) {
      contentGroups.push(cur.join('\n'));
      cur = [p];
    } else {
      cur.push(p);
    }
  }
  if (cur.length >= 2) contentGroups.push(cur.join('\n'));

  // ── Pick the strategy with the most questions found ───────────────────────────
  let best = [];
  if (paraBlocks.length    > best.length) best = paraBlocks;
  if (compactBlocks.length > best.length) best = compactBlocks;
  if (numBest.length       > best.length) best = numBest;
  if (contentGroups.length > best.length) best = contentGroups;

  if (best.length < 3) return [normalized];

  return best.map(q => q.replace(/^\d{1,3}[.)]\s*/, '').trim());
}
