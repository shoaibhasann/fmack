'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Question, QuestionFilters, PaginatedResult } from '@/modules/question/question.types';
import type { CreateQuestionInput, UpdateQuestionInput } from '@/modules/question/question.schema';

export function useQuestions(filters: QuestionFilters & { page?: number; limit?: number } = {}) {
  const params = new URLSearchParams(
    Object.entries(filters)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)])
  );

  return useQuery<PaginatedResult<Question>>({
    queryKey: ['questions', filters],
    queryFn:  async () => {
      const res = await fetch(`/api/questions?${params}`);
      if (!res.ok) throw new Error('Failed to fetch questions');
      return res.json();
    },
  });
}

export function useQuestion(id: string) {
  return useQuery<Question>({
    queryKey: ['questions', id],
    queryFn:  async () => {
      const res = await fetch(`/api/questions/${id}`);
      if (!res.ok) throw new Error('Question not found');
      return res.json();
    },
    enabled: !!id,
  });
}

export function useCreateQuestion() {
  const queryClient = useQueryClient();
  return useMutation<Question, Error, CreateQuestionInput>({
    mutationFn: async (data) => {
      const res = await fetch('/api/questions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'Failed to create question');
      }
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['questions'] }),
  });
}

export function useUpdateQuestion() {
  const queryClient = useQueryClient();
  return useMutation<Question, Error, UpdateQuestionInput & { id: string }>({
    mutationFn: async ({ id, ...data }) => {
      const res = await fetch(`/api/questions/${id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'Failed to update question');
      }
      return res.json();
    },
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['questions'] });
      queryClient.invalidateQueries({ queryKey: ['questions', id] });
    },
  });
}

export function useDeleteQuestion() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: async (id) => {
      const res = await fetch(`/api/questions/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete question');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['questions'] }),
  });
}
