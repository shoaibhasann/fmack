import prisma from '@/lib/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

export async function findDistinctSubjects(
  examCategory?: string
): Promise<{ subject: string }[]> {
  return db.question.findMany({
    where:    { subject: { not: null } },
    select:   { subject: true },
    distinct: ['subject'],
    orderBy:  { subject: 'asc' },
  });
}
