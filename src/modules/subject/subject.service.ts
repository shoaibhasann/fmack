import * as repo from './subject.repository';

export async function listSubjects(examCategory?: string): Promise<string[]> {
  const rows = await repo.findDistinctSubjects(examCategory);
  return rows.map(r => r.subject).filter(Boolean) as string[];
}
