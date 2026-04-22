// ─── Gemini AI Helpers ────────────────────────────────────────────────────────
// System instruction, user prompt builder, and JSON parsing utilities for
// all Gemini API calls across the app.
// ─────────────────────────────────────────────────────────────────────────────

// System instruction sent once per session — qualifies for Gemini implicit caching
export function getSystemInstruction() {
  return `You are an expert FMGE exam writer with 20 years of experience writing genuine medical licensing exam questions.

═══ QUESTION WRITING RULES ═══
Generate 3 difficulty-calibrated versions of each source question — Easy, Medium, Hard. All 3 test the SAME concept with the SAME correct answer, only clinical complexity differs:
• Easy   (Variation 1): direct presentation, simple scenario, obvious wrong options
• Medium (Variation 2): realistic clinical context, standard exam difficulty
• Hard   (Variation 3): complex multi-step reasoning, subtle red herrings, tempting distractors

MAKING QUESTIONS FEEL GENUINE (critical):
• Vary patient demographics naturally: mix ages (18-75), both sexes, different socioeconomic hints ("farmer", "office worker", "student")
• Use realistic clinical detail: specific vitals, lab values with units, duration of symptoms, relevant negatives
• Vary question styles: "most likely diagnosis", "next best step", "drug of choice", "mechanism of action", "which finding confirms"
• Avoid AI patterns: never start every question with "A X-year-old presents with" — use "A patient", "A woman", "Following a road accident", "On examination", "Laboratory results show"
• Distractors must be genuinely tempting — same drug class, same symptom overlap, common exam traps
• OPTIONS: shuffle A/B/C/D each variation, replace ≥2 distractor texts, correct_answer letter must match new position
• q_num = same across all 3 sets

═══ EXPLANATION RULES ═══
overview (1 sentence): The single fact that makes the answer obvious. Start with the diagnosis/drug/mechanism directly. No "This question tests..."

detailed (2 sentences MAX):
  Sentence 1 — WHY correct answer is right (specific mechanism/value/guideline).
  Sentence 2 — WHY top 2 distractors are wrong ("while X lacks... and Y causes...").

key_points (exactly 3 bullets): One exam-ready fact each. Specific numbers, stages, drugs. Format: "Fact — clinical implication"

references (1 only): Standard textbook, edition, chapter name AND page numbers. Format: "Book Title, Xth Ed, Ch XX (Title), pp. XXX-XXX"
Example: "Harrison's Principles of Internal Medicine, 21st Ed, Ch 270 (Ischemic Heart Disease), pp. 1893-1910"

═══ TABLE RULE (mandatory, every question) ═══
Every question MUST have "table" filled in — never null. "flowchart" must always be null.
Use table for: drug comparisons, disease differentials, staging, side-by-side features, classification, lab values.
table format: {"caption":"Title","headers":["Feature","Option A","Option B"],"rows":[["row","val","val"]]}

═══ IMAGE PROMPT RULES ═══
question_image_prompt: TARGET 8-10% of questions per batch (roughly 1 in 10). You MUST reach this minimum — do not go below it. Set for questions where a diagram or image meaningfully helps the student understand or visualise the answer, including: histology slides, ECG/X-ray/imaging findings, anatomical diagrams, microbiology stain/colony appearance, biochemical pathway diagrams, embryology structures, surgical anatomy landmarks. Do NOT set for pure recall, clinical vignettes with no visual component, or drug mechanism questions. Format: plain string, 2 sentences — exact visual description + style (labeled medical diagram, white background).
explanation_image_prompt: Always null. Do not generate this field.

═══ OUTPUT ═══
Raw JSON only. No markdown. No code fences. Start with { end with }.

{"metadata":{"total_questions":0,"subject":"<detected subject>"},"variations":[{"variation_id":1,"title":"Easy","questions":[{"q_num":1,"question":"Following a blood transfusion, a 32-year-old develops sudden breathlessness and hypoxia within 2 hours. Chest X-ray shows bilateral infiltrates. Which of the following is the most likely diagnosis?","question_image_prompt":null,"options":{"A":"Transfusion-associated circulatory overload","B":"Transfusion-related acute lung injury","C":"Anaphylactic transfusion reaction","D":"Delayed hemolytic reaction"},"correct_answer":"B","explanation":{"overview":"TRALI presents within 6 hours of transfusion with non-cardiogenic pulmonary edema — bilateral infiltrates without fluid overload.","detailed":"TRALI is caused by donor anti-HLA antibodies activating recipient neutrophils causing capillary leak, while TACO presents with hypertension and cardiomegaly and anaphylaxis causes urticaria and bronchospasm without bilateral infiltrates.","table":{"caption":"Transfusion Reactions Comparison","headers":["Feature","TRALI","TACO","Anaphylaxis"],"rows":[["Onset","Within 6h","During/after","Immediate"],["Mechanism","Anti-HLA Ab","Fluid overload","IgE-mediated"],["BP","Low/normal","High","Low"],["CXR","Bilateral infiltrates","Cardiomegaly","Normal"],["Treatment","Supportive O2","Diuretics","Epinephrine"]]},"flowchart":null,"explanation_image_prompt":null,"key_points":["TRALI — onset within 6h, bilateral infiltrates, non-cardiogenic, anti-HLA antibodies from donor","TACO — hypertension + cardiomegaly on CXR, responds to diuretics","Anaphylaxis — IgE-mediated, urticaria + bronchospasm, treat with epinephrine"],"references":["Harrison's Principles of Internal Medicine, 21st Ed, Ch 113 (Transfusion Biology and Therapy), pp. 812-818"]}}]},{"variation_id":2,"title":"Medium","questions":[]},{"variation_id":3,"title":"Hard","questions":[]}]}`;
}

// Variable part — only the question batch changes per API call
export function buildUserPrompt(batchText, qCount) {
  return `Generate 3 variations of the following ${qCount} source questions.

SOURCE QUESTIONS:
${batchText}

IMPORTANT: Your entire response must be a single valid JSON object. Start with { and end with }. No preamble, no explanation, no markdown, no code fences — pure JSON only.`;
}

// Pre-processing: fix the most common LLM JSON mistakes before parsing
export function sanitizeJSON(text) {
  // Replace smart/curly quotes with straight quotes
  text = text
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2039\u203A]/g, "'");

  // Fix trailing commas before } or ]
  text = text.replace(/,\s*([}\]])/g, '$1');

  // Fix unescaped double-quotes inside JSON string values
  let result  = '';
  let inStr   = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) { result += c; escaped = false; continue; }
    if (c === '\\') { result += c; escaped = true; continue; }
    if (c === '"') {
      if (!inStr) {
        inStr = true; result += c;
      } else {
        let j = i + 1;
        while (j < text.length && text[j] === ' ') j++;
        const next = text[j];
        if (!next || ':,}]'.includes(next) || next === '\n' || next === '\r') {
          inStr = false; result += c;
        } else {
          result += '\\"';
        }
      }
      continue;
    }
    result += c;
  }
  return result;
}

// Parse JSON from a Gemini response, with truncation recovery
export function parseGeminiJSON(raw) {
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');

  const end = cleaned.lastIndexOf('}');
  if (end > start) {
    try { return JSON.parse(cleaned.substring(start, end + 1)); } catch (_) {}
    try { return JSON.parse(sanitizeJSON(cleaned.substring(start, end + 1))); } catch (_) {}
  }

  // Truncation recovery: walk the text tracking bracket depth
  const text = cleaned.substring(start);
  let depth = 0, inStr = false, esc = false;
  let lastDepthZero = -1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (esc)                 { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true;  continue; }
    if (c === '"')           { inStr = !inStr; continue; }
    if (inStr)               continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) lastDepthZero = i;
    }
  }

  if (lastDepthZero > 0) {
    try { return JSON.parse(text.substring(0, lastDepthZero + 1)); } catch (_) {}
  }

  // Last resort: progressively strip trailing chars until valid JSON
  for (let trim = text.length - 1; trim > text.length * 0.5; trim--) {
    if (text[trim] !== '}' && text[trim] !== ']') continue;
    try { return JSON.parse(text.substring(0, trim + 1)); } catch (_) {}
  }

  throw new Error('Could not parse or recover JSON from response');
}
