'use client';

import { useQuery } from '@tanstack/react-query';

export function useSubjects(examCategory?: string) {
  return useQuery<string[]>({
    queryKey: ['subjects', examCategory],
    queryFn:  async () => {
      const params = examCategory ? `?examCategory=${examCategory}` : '';
      const res = await fetch(`/api/subjects${params}`);
      if (!res.ok) throw new Error('Failed to fetch subjects');
      const data: { subjects: string[] } = await res.json();
      return data.subjects;
    },
  });
}
