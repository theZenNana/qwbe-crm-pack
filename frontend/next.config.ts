import type { NextConfig } from "next";

// Same trap as qwbe/web/next.config.mjs: Next dev only serves its chunks to hosts it knows.
// Opt LAN hosts in with QWBE_DEV_ORIGINS=192.168.1.154 (comma-separated).
const devOrigins = (process.env.QWBE_DEV_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  ...(devOrigins.length > 0 ? { allowedDevOrigins: devOrigins } : {}),
};

export default nextConfig;
