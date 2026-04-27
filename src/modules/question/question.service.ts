import * as repo from './question.repository';
import type {
  Question,
  CreateQuestionData,
  UpdateQuestionData,
  PaginatedResult,
  QuestionFilters,
} from './question.types';

export async function listQuestions({
  page    = 1,
  limit   = 20,
  filters = {},
}: {
  page?:    number;
  limit?:   number;
  filters?: QuestionFilters;
} = {}): Promise<PaginatedResult<Question>> {
  const skip = (page - 1) * limit;
  const [questions, total] = await Promise.all([
    repo.findManyQuestions({ where: filters, skip, take: limit }),
    repo.countQuestions(filters),
  ]);
  return { data: questions as Question[], total, page, pages: Math.ceil(total / limit) };
}

export async function getQuestion(id: string): Promise<Question> {
  const question = await repo.findQuestionById(id);
  if (!question) throw new Error('Question not found');
  return question as Question;
}

export async function createQuestion(data: CreateQuestionData): Promise<Question> {
  return repo.createQuestion(data) as Promise<Question>;
}

export async function updateQuestion(id: string, data: UpdateQuestionData): Promise<Question> {
  await getQuestion(id); // throws 404 if not found
  return repo.updateQuestion(id, data) as Promise<Question>;
}

export async function deleteQuestion(id: string): Promise<void> {
  await getQuestion(id); // throws 404 if not found
  await repo.deleteQuestion(id);
}
