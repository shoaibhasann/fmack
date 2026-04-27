import { NextRequest, NextResponse } from 'next/server';
import * as questionService from '@/modules/question/question.service';
import { QuestionFilterSchema, CreateQuestionSchema } from '@/modules/question/question.schema';
import { parseOrThrow } from '@/lib/validators';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, ...filters } = parseOrThrow(
      QuestionFilterSchema,
      Object.fromEntries(searchParams)
    );
    const result = await questionService.listQuestions({ page, limit, filters });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body     = await request.json();
    const data     = parseOrThrow(CreateQuestionSchema, body);
    const question = await questionService.createQuestion(data);
    return NextResponse.json(question, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
