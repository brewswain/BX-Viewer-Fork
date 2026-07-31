import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: false, // the canvas engine is imperative; double-invoked effects churn RAF loops
  // Media is streamed from the repo root by route handlers, never bundled.
  serverExternalPackages: ['archiver', 'busboy', 'yauzl'],
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ]
  },
}

export default nextConfig
