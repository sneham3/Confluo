import type { Metadata, Viewport } from 'next';
import { Fraunces, Inter, Source_Serif_4 } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';

const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap', axes: ['opsz'] });
const sourceSerif = Source_Serif_4({ subsets: ['latin'], variable: '--font-source-serif', display: 'swap' });
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(WEB_URL),
  title: { default: 'Confluo', template: '%s · Confluo' },
  description: 'Write together. Never lose a word. A collaborative editor with conflict-free merging, live cursors and offline-safe sync.',
  openGraph: {
    type: 'website',
    siteName: 'Confluo',
    title: 'Confluo — Write together. Never lose a word.',
    description: 'Conflict-free collaborative editing with live presence, block locks and offline-safe sync.',
    url: WEB_URL,
  },
  twitter: { card: 'summary_large_image', title: 'Confluo', description: 'Write together. Never lose a word.' },
  robots: { index: true, follow: true },
  alternates: { canonical: '/' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FBFAF7' },
    { media: '(prefers-color-scheme: dark)', color: '#141412' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${sourceSerif.variable} ${inter.variable}`} suppressHydrationWarning>
      <body className="min-h-full">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
