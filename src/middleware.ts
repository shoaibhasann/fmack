import { NextRequest, NextResponse } from 'next/server';

// Auth guard — protects all admin routes
// TODO: replace stub with your auth provider (NextAuth getToken, Clerk clerkMiddleware, etc.)

const PROTECTED_PATHS = ['/dashboard', '/questions', '/subjects', '/exams', '/tags'];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const isProtected  = PROTECTED_PATHS.some(p => pathname.startsWith(p));

  if (isProtected) {
    // const token = request.cookies.get('session')?.value;
    // if (!token) return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
