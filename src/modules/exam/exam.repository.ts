import prisma from '@/lib/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

export interface ExamPaperFilters {
  examCategory?: string;
  examType?:     string;
  isPublished?:  boolean;
}

export async function findAllExamPapers(where: ExamPaperFilters = {}) {
  return db.examPaper.findMany({
    where,
    orderBy: [{ examCategory: 'asc' }, { year: 'desc' }],
  });
}

export async function findExamPaperBySourceCode(sourceCode: string) {
  return db.examPaper.findUnique({ where: { sourceCode } });
}

export async function upsertExamPaper(sourceCode: string, data: Record<string, unknown>) {
  return db.examPaper.upsert({
    where:  { sourceCode },
    update: data,
    create: { sourceCode, ...data },
  });
}
