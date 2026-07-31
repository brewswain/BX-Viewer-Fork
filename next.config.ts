import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: false, // the canvas engine is imperative; double-invoked effects churn RAF loops
  // Media is streamed from the repo root by route handlers, never bundled.
  //
  // archiver/busboy/yauzl are deliberately NOT in serverExternalPackages. Turbopack
  // externalises a package by junctioning it into .next/node_modules, and exFAT has no
  // reparse points at all, so the build dies with "Incorrect function (os error 1)".
  // Bundling them instead is verified working: export streams a valid zip (archiver),
  // import reads one (yauzl), and multipart upload parses (busboy). Re-adding the key
  // means giving up Turbopack and building with --webpack.
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
