import type { Metadata } from 'next';
import '@/styles/globals.css';
import Providers from '@/components/providers';

export const metadata: Metadata = {
  title: 'FMACK — Exam Platform',
  description: 'Multi-exam question bank platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
