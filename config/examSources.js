// ─── Exam Sources Config ───────────────────────────────────────────────────────
// Single source of truth for all supported PYQ exam types, years, and sessions.
//
// FMGE    → held TWICE a year (June + December)
// NEET PG → held ONCE  a year (session = null)
//
// To add a new exam or year: push a new entry here — the DB schema never changes.
// ─────────────────────────────────────────────────────────────────────────────

export const EXAM_SOURCES = [
  // ── FMGE 2025 ──────────────────────────────────────────────────────────────
  { exam_type: 'FMGE',    year: 2025, session: 'june',     source_code: 'fmge_june_2025',     label: 'FMGE June 2025' },

  // ── FMGE 2024 ──────────────────────────────────────────────────────────────
  { exam_type: 'FMGE',    year: 2024, session: 'december', source_code: 'fmge_december_2024', label: 'FMGE December 2024' },
  { exam_type: 'FMGE',    year: 2024, session: 'june',     source_code: 'fmge_june_2024',     label: 'FMGE June 2024' },

  // ── FMGE 2023 ──────────────────────────────────────────────────────────────
  { exam_type: 'FMGE',    year: 2023, session: 'december', source_code: 'fmge_december_2023', label: 'FMGE December 2023' },
  { exam_type: 'FMGE',    year: 2023, session: 'june',     source_code: 'fmge_june_2023',     label: 'FMGE June 2023' },

  // ── FMGE 2022 ──────────────────────────────────────────────────────────────
  { exam_type: 'FMGE',    year: 2022, session: 'december', source_code: 'fmge_december_2022', label: 'FMGE December 2022' },
  { exam_type: 'FMGE',    year: 2022, session: 'june',     source_code: 'fmge_june_2022',     label: 'FMGE June 2022' },

  // ── FMGE 2021 ──────────────────────────────────────────────────────────────
  { exam_type: 'FMGE',    year: 2021, session: 'december', source_code: 'fmge_december_2021', label: 'FMGE December 2021' },
  { exam_type: 'FMGE',    year: 2021, session: 'june',     source_code: 'fmge_june_2021',     label: 'FMGE June 2021' },

  // ── NEET PG (one session per year) ─────────────────────────────────────────
  { exam_type: 'NEET_PG', year: 2025, session: null, source_code: 'neet_pg_2025', label: 'NEET PG 2025' },
  { exam_type: 'NEET_PG', year: 2024, session: null, source_code: 'neet_pg_2024', label: 'NEET PG 2024' },
  { exam_type: 'NEET_PG', year: 2023, session: null, source_code: 'neet_pg_2023', label: 'NEET PG 2023' },
  { exam_type: 'NEET_PG', year: 2022, session: null, source_code: 'neet_pg_2022', label: 'NEET PG 2022' },
  { exam_type: 'NEET_PG', year: 2021, session: null, source_code: 'neet_pg_2021', label: 'NEET PG 2021' },
];

// Medical subjects — drives subject dropdowns in admin + generator UIs
export const SUBJECTS = [
  'Anatomy', 'Physiology', 'Biochemistry', 'Pathology',
  'Pharmacology', 'Microbiology', 'Forensic Medicine',
  'Community Medicine', 'Medicine', 'Surgery', 'Obstetrics & Gynaecology',
  'Paediatrics', 'Ophthalmology', 'ENT', 'Dermatology',
  'Psychiatry', 'Radiology', 'Orthopaedics', 'Anaesthesia',
];
