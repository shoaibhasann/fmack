import prisma from '@/lib/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

export async function findAllTags(): Promise<string[]> {
  const rows: { tags: string[] }[] = await db.question.findMany({
    select: { tags: true },
  });
  const tagSet = new Set(rows.flatMap(r => r.tags));
  return [...tagSet].sort();
}
