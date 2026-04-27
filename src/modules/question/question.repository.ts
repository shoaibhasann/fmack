import prisma from '@/lib/prisma';
import type { CreateQuestionData, UpdateQuestionData, QuestionFilters } from './question.types';

// TODO: Replace `db` cast with typed `prisma` once Prisma schema defines Question model
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

export async function findManyQuestions({
  where = {},
  orderBy = { createdAt: 'desc' },
  skip  = 0,
  take  = 20,
}: {
  where?:   QuestionFilters;
  orderBy?: Record<string, string>;
  skip?:    number;
  take?:    number;
} = {}) {
  return db.question.findMany({ where, orderBy, skip, take });
}

export async function countQuestions(where: QuestionFilters = {}): Promise<number> {
  return db.question.count({ where });
}

export async function findQuestionById(id: string) {
  return db.question.findUnique({ where: { id } });
}

export async function createQuestion(data: CreateQuestionData) {
  return db.question.create({ data });
}

export async function updateQuestion(id: string, data: UpdateQuestionData) {
  return db.question.update({ where: { id }, data });
}

export async function deleteQuestion(id: string) {
  return db.question.delete({ where: { id } });
}
