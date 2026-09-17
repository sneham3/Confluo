import type { NextConfig } from 'next';

/**
 * Next.js dev blocks its own client resources (/_next/*, HMR) for any host other than localhost.
 * When the app is opened from another device on the LAN (http://<laptop-ip>:3000), that host must
 * be allowed or the page never hydrates. Derived from the configured web URL so it follows the IP.
 */
const allowedDevOrigins = [process.env.NEXT_PUBLIC_WEB_URL, process.env.WEB_URL]
  .map((u) => {
    try {
      return u ? new URL(u).hostname : null;
    } catch {
      return null;
    }
  })
  .filter((h): h is string => !!h && h !== 'localhost');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins,
  transpilePackages: ['@confluo/editor', '@confluo/editor-schema', '@confluo/shared'],
  typescript: { ignoreBuildErrors: false },
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    },
  ],
};

export default nextConfig;
