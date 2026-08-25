import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const rootEnvironmentFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnvironmentFile)) process.loadEnvFile(rootEnvironmentFile);

const nextConfig: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  reactStrictMode: true,
  output: "standalone",
};

export default nextConfig;
