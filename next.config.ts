import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: false,
  agentRules: false,
  experimental: {
    serverActions: {
      // Place photos are posted to server actions. The browser shrinks them
      // first, and the form refuses a batch over IMAGE_BATCH_MAX_BYTES; this
      // leaves room for the multipart overhead. The default 1MB rejected most
      // phone photos.
      bodySizeLimit: "16mb",
    },
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "https", hostname: "**.supabase.in" },
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "geolocation=(self), camera=(), microphone=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
