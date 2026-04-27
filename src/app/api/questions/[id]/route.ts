import { NextRequest, NextResponse } from 'next/server';
import * as questionService from '@/modules/question/question.service';
import { UpdateQuestionSchema } from '@/modules/question/question.schema';
import { parseOrThrow } from '@/lib/validators';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const question = await questionService.getQuestion(id);
    return NextResponse.json(question);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const body     = await request.json();
    const data     = parseOrThrow(UpdateQuestionSchema, body);
    const question = await questionService.updateQuestion(id, data);
    return NextResponse.json(question);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    await questionService.deleteQuestion(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
