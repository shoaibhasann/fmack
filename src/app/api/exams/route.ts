import { NextRequest, NextResponse } from 'next/server';
import * as examService from '@/modules/exam/exam.service';
import type { ExamPaperFilters } from '@/modules/exam/exam.repository';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const filters: ExamPaperFilters = {};
    const examCategory = searchParams.get('examCategory');
    const examType     = searchParams.get('examType');
    if (examCategory) filters.examCategory = examCategory;
    if (examType)     filters.examType     = examType;
    const papers = await examService.listExamPapers(filters);
    return NextResponse.json({ papers });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
