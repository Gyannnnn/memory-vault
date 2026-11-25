import type { Metadata, Viewport } from 'next';
import { SUSE } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import './globals.css';

// Downloaded once at build time and served from this app; pages never call Google.
const sans = SUSE({ subsets: ['latin'], variable: '--font-sans-face', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Memory Vault', template: '%s · Memory Vault' },
  description: 'Your private photo and video library.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FAFAFA' },
    { media: '(prefers-color-scheme: dark)', color: '#09090B' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={sans.variable} suppressHydrationWarning>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
