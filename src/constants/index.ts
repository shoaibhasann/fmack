// ─── Exam taxonomy — single source of truth ──────────────────────────────────

export interface ExamCategory {
  code:      string;
  name:      string;
  sortOrder: number;
}

export interface Exam {
  category: string;
  code:     string;
  name:     string;
}

export interface ExamPaper {
  exam:    string;
  year:    number;
  session: string | null;
  code:    string;
  label:   string;
}

export const EXAM_CATEGORIES: ExamCategory[] = [
  { code: 'MEDICAL',     name: 'Medical',           sortOrder: 1 },
  { code: 'ENGINEERING', name: 'Engineering',        sortOrder: 2 },
  { code: 'GOVERNMENT',  name: 'Government & Civil', sortOrder: 3 },
  { code: 'TECH',        name: 'Technology & IT',    sortOrder: 4 },
];

export const EXAMS: Exam[] = [
  { category: 'MEDICAL',     code: 'FMGE',         name: 'FMGE' },
  { category: 'MEDICAL',     code: 'NEET_PG',      name: 'NEET PG' },
  { category: 'MEDICAL',     code: 'NEET_UG',      name: 'NEET UG' },
  { category: 'MEDICAL',     code: 'AIIMS_PG',     name: 'AIIMS PG' },
  { category: 'ENGINEERING', code: 'JEE_MAINS',    name: 'JEE Mains' },
  { category: 'ENGINEERING', code: 'JEE_ADVANCED',  name: 'JEE Advanced' },
  { category: 'ENGINEERING', code: 'GATE',          name: 'GATE' },
  { category: 'ENGINEERING', code: 'BITSAT',        name: 'BITSAT' },
  { category: 'GOVERNMENT',  code: 'UPSC_CSE',     name: 'UPSC CSE' },
  { category: 'GOVERNMENT',  code: 'SSC_CGL',      name: 'SSC CGL' },
  { category: 'GOVERNMENT',  code: 'SSC_CHSL',     name: 'SSC CHSL' },
  { category: 'GOVERNMENT',  code: 'BANKING_PO',   name: 'Banking PO' },
  { category: 'GOVERNMENT',  code: 'RAILWAYS',     name: 'Railways (RRB)' },
  { category: 'TECH',        code: 'GATE_CS',      name: 'GATE CS' },
  { category: 'TECH',        code: 'PLACEMENT',    name: 'Campus Placement' },
];

export const EXAM_PAPERS: ExamPaper[] = [
  { exam: 'FMGE', year: 2025, session: 'june',     code: 'fmge_june_2025',     label: 'FMGE June 2025' },
  { exam: 'FMGE', year: 2024, session: 'december', code: 'fmge_december_2024', label: 'FMGE December 2024' },
  { exam: 'FMGE', year: 2024, session: 'june',     code: 'fmge_june_2024',     label: 'FMGE June 2024' },
  { exam: 'FMGE', year: 2023, session: 'december', code: 'fmge_december_2023', label: 'FMGE December 2023' },
  { exam: 'FMGE', year: 2023, session: 'june',     code: 'fmge_june_2023',     label: 'FMGE June 2023' },
  { exam: 'FMGE', year: 2022, session: 'december', code: 'fmge_december_2022', label: 'FMGE December 2022' },
  { exam: 'FMGE', year: 2022, session: 'june',     code: 'fmge_june_2022',     label: 'FMGE June 2022' },
  { exam: 'FMGE', year: 2021, session: 'december', code: 'fmge_december_2021', label: 'FMGE December 2021' },
  { exam: 'FMGE', year: 2021, session: 'june',     code: 'fmge_june_2021',     label: 'FMGE June 2021' },
  { exam: 'NEET_PG', year: 2025, session: null, code: 'neet_pg_2025', label: 'NEET PG 2025' },
  { exam: 'NEET_PG', year: 2024, session: null, code: 'neet_pg_2024', label: 'NEET PG 2024' },
  { exam: 'NEET_PG', year: 2023, session: null, code: 'neet_pg_2023', label: 'NEET PG 2023' },
  { exam: 'NEET_PG', year: 2022, session: null, code: 'neet_pg_2022', label: 'NEET PG 2022' },
  { exam: 'NEET_UG', year: 2025, session: null, code: 'neet_ug_2025', label: 'NEET UG 2025' },
  { exam: 'NEET_UG', year: 2024, session: null, code: 'neet_ug_2024', label: 'NEET UG 2024' },
  { exam: 'NEET_UG', year: 2023, session: null, code: 'neet_ug_2023', label: 'NEET UG 2023' },
  { exam: 'JEE_MAINS', year: 2025, session: 'jan', code: 'jee_mains_jan_2025', label: 'JEE Mains Jan 2025' },
  { exam: 'JEE_MAINS', year: 2025, session: 'apr', code: 'jee_mains_apr_2025', label: 'JEE Mains Apr 2025' },
  { exam: 'JEE_MAINS', year: 2024, session: 'jan', code: 'jee_mains_jan_2024', label: 'JEE Mains Jan 2024' },
  { exam: 'JEE_ADVANCED', year: 2025, session: null, code: 'jee_advanced_2025', label: 'JEE Advanced 2025' },
  { exam: 'JEE_ADVANCED', year: 2024, session: null, code: 'jee_advanced_2024', label: 'JEE Advanced 2024' },
  { exam: 'GATE', year: 2025, session: null, code: 'gate_2025', label: 'GATE 2025' },
  { exam: 'GATE', year: 2024, session: null, code: 'gate_2024', label: 'GATE 2024' },
  { exam: 'UPSC_CSE', year: 2025, session: null, code: 'upsc_cse_2025', label: 'UPSC CSE 2025' },
  { exam: 'UPSC_CSE', year: 2024, session: null, code: 'upsc_cse_2024', label: 'UPSC CSE 2024' },
  { exam: 'SSC_CGL', year: 2024, session: null, code: 'ssc_cgl_2024', label: 'SSC CGL 2024' },
  { exam: 'SSC_CGL', year: 2023, session: null, code: 'ssc_cgl_2023', label: 'SSC CGL 2023' },
];

export const SUBJECTS_BY_CATEGORY: Record<string, string[]> = {
  MEDICAL: [
    'Anatomy', 'Physiology', 'Biochemistry', 'Pathology',
    'Pharmacology', 'Microbiology', 'Forensic Medicine',
    'Community Medicine', 'Medicine', 'Surgery',
    'Obstetrics & Gynaecology', 'Paediatrics', 'Ophthalmology',
    'ENT', 'Dermatology', 'Psychiatry', 'Radiology',
    'Orthopaedics', 'Anaesthesia',
  ],
  ENGINEERING: [
    'Physics', 'Chemistry', 'Mathematics',
    'Engineering Mathematics', 'General Aptitude',
    'Computer Science', 'Electronics & Communication',
    'Mechanical Engineering', 'Civil Engineering', 'Electrical Engineering',
  ],
  GOVERNMENT: [
    'General Knowledge', 'General Awareness', 'Current Affairs',
    'Quantitative Aptitude', 'Logical Reasoning', 'English Language',
    'General Science', 'History', 'Geography', 'Indian Polity',
    'Indian Economy', 'Environment & Ecology',
  ],
  TECH: [
    'Data Structures & Algorithms', 'Operating Systems', 'DBMS',
    'Computer Networks', 'System Design', 'OOP',
    'Web Development', 'Machine Learning', 'SQL',
    'Python', 'Java', 'JavaScript',
  ],
};

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export const QUESTION_TYPES = ['pyq', 'practice', 'mock', 'concept'] as const;
export const SUBSCRIPTION_TYPES = ['free', 'premium', 'pro'] as const;

export type DifficultyValue     = (typeof DIFFICULTIES)[number];
export type QuestionTypeValue   = (typeof QUESTION_TYPES)[number];
export type SubscriptionValue   = (typeof SUBSCRIPTION_TYPES)[number];

export function getCategoryForExam(examCode: string): string {
  return EXAMS.find(e => e.code === examCode)?.category ?? 'MEDICAL';
}

export function getExamsForCategory(categoryCode: string): Exam[] {
  return EXAMS.filter(e => e.category === categoryCode);
}

export function getPapersForExam(examCode: string): ExamPaper[] {
  return EXAM_PAPERS.filter(p => p.exam === examCode);
}
