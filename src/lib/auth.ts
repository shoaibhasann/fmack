// Auth — wire up NextAuth.js or Clerk here once decided
// NextAuth: npm install next-auth
// Clerk:    npm install @clerk/nextjs

export interface Session {
  user: {
    id: string;
    email: string;
    role: string;
  };
}

export async function getServerSession(): Promise<Session | null> {
  // TODO: return session from your auth provider
  return null;
}

type Handler = (request: Request, context: unknown) => Promise<Response>;

export function requireAuth(handler: Handler): Handler {
  return async (request, context) => {
    const session = await getServerSession();
    if (!session) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return handler(request, context);
  };
}
