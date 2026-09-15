import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // Logs moved off the root when Landscape arrived. Temporary (307) so the
      // root stays free to become a real page later without a cached 308.
      { source: "/", destination: "/logs", permanent: false },
    ];
  },
};

export default nextConfig;
