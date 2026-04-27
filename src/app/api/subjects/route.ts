import { NextRequest, NextResponse } from 'next/server';
import * as subjectService from '@/modules/subject/subject.service';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const examCategory = searchParams.get('examCategory') ?? undefined;
    const subjects = await subjectService.listSubjects(examCategory);
    return NextResponse.json({ subjects });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
