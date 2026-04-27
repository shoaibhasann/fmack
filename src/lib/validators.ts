import { z, ZodSchema } from 'zod';

export const uuidSchema = z.string().uuid('Invalid ID format');

export const paginationSchema = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function parseOrThrow<T>(schema: ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.errors
      .map(e => `${e.path.join('.')}: ${e.message}`)
      .join(', ');
    throw new Error(message);
  }
  return result.data;
}

export function apiError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}
