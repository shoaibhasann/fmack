// ─── DB Row → PDF Shape Transform ────────────────────────────────────────────
// Maps a raw PostgreSQL question row (from the `questions` table) to the
// format that buildPDFHtml() expects.
// ─────────────────────────────────────────────────────────────────────────────

export function dbQToPdf(q, idx) {
  // explanation stored as JSONB — handle array, plain string, or null
  const expArr = Array.isArray(q.explanation)
    ? q.explanation
    : (q.explanation ? [String(q.explanation)] : []);

  return {
    q_num:        idx + 1,
    question:     q.stem,
    subject:      q.subject || null,
    topic:        q.topic   || null,
    tags:         Array.isArray(q.tags) ? q.tags : [],
    options: {
      A: q.option_a || '',
      B: q.option_b || '',
      C: q.option_c || '',
      D: q.option_d || '',
    },
    correct_answer:        (q.correct_option || 'a').toUpperCase(),
    question_image_prompt: null,
    explanation: {
      overview:   expArr[0] || '',
      detailed:   expArr.slice(1).join(' ') || '',
      table:      null,
      key_points: [],
    },
  };
}
