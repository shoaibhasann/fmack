import { z } from 'zod';

export const CreateQuestionSchema = z.object({
  stem:          z.string().min(1, 'Stem is required'),
  optionA:       z.string().min(1, 'Option A is required'),
  optionB:       z.string().min(1, 'Option B is required'),
  optionC:       z.string().min(1, 'Option C is required'),
  optionD:       z.string().min(1, 'Option D is required'),
  correctOption: z.enum(['a', 'b', 'c', 'd']),
  subject:       z.string().optional(),
  topic:         z.string().optional(),
  subtopic:      z.string().optional(),
  difficulty:    z.enum(['easy', 'medium', 'hard']).default('medium'),
  tags:          z.array(z.string()).default([]),
  explanationText:      z.string().optional(),
  questionImageUrl:     z.string().url().optional().nullable(),
  explanationImageUrls: z.array(z.string().url()).default([]),
  explanationTables:    z.record(z.unknown()).optional().nullable(),
  isActive:             z.boolean().default(true),
  createdBy:            z.string().default('admin'),
});

export const UpdateQuestionSchema = CreateQuestionSchema.partial();

export const QuestionFilterSchema = z.object({
  subject:    z.string().optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  isActive:   z.coerce.boolean().optional(),
  search:     z.string().optional(),
  page:       z.coerce.number().int().min(1).default(1),
  limit:      z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateQuestionInput  = z.infer<typeof CreateQuestionSchema>;
export type UpdateQuestionInput  = z.infer<typeof UpdateQuestionSchema>;
export type QuestionFilterInput  = z.infer<typeof QuestionFilterSchema>;
