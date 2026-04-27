import * as repo from './exam.repository';
import type { ExamPaperFilters } from './exam.repository';

export async function listExamPapers(filters: ExamPaperFilters = {}) {
  return repo.findAllExamPapers(filters);
}

export async function getExamPaper(sourceCode: string) {
  const paper = await repo.findExamPaperBySourceCode(sourceCode);
  if (!paper) throw new Error(`Exam paper "${sourceCode}" not found`);
  return paper;
}
