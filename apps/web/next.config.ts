import type { NextConfig } from 'next';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

const nextConfig: NextConfig = {
  // Allow accessing the dev server via the VPS IP without cross-origin warnings.
  // This does not affect production behaviour; it only governs dev asset access.
  allowedDevOrigins: ['158.220.100.255'],
  async rewrites() {
    return [
      {
        source: '/assessment/:path*',
        destination: `${API_BASE_URL}/assessment/:path*`,
      },
      {
        source: '/config/:path*',
        destination: `${API_BASE_URL}/config/:path*`,
      },
      {
        source: '/identity/:path*',
        destination: `${API_BASE_URL}/identity/:path*`,
      },
    ];
  },
};

export default nextConfig;
