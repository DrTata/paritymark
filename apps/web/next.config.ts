import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow accessing the dev server via the VPS IP without cross-origin warnings.
  // This does not affect production behaviour; it only governs dev asset access.
  allowedDevOrigins: ["158.220.100.255"],
};

export default nextConfig;
