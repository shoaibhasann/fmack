import { NextRequest, NextResponse } from 'next/server';
import { uploadToR2, isR2Configured } from '@/lib/r2';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function POST(request: NextRequest) {
  try {
    if (!isR2Configured()) {
      return NextResponse.json(
        { error: 'Image upload not configured — add R2_* variables to .env' },
        { status: 503 }
      );
    }

    const formData = await request.formData();
    const file     = formData.get('image') as File | null;
    const folder   = formData.get('folder') === 'explanations'
      ? 'pyq/explanations'
      : 'pyq/questions';

    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: 'Only JPG, PNG, WEBP, GIF allowed' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const url    = await uploadToR2(buffer, folder, file.name, file.type);
    return NextResponse.json({ success: true, url });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
