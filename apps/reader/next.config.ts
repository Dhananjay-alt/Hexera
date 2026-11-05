import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// Share the monorepo's root .env with the demo app.
const rootEnv = resolve(__dirname, "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config: NextConfig = {
  transpilePackages: ["@hexera/core", "@hexera/client", "@hexera/hedera"],
  serverExternalPackages: ["@hiero-ledger/sdk"],
  env: {
    NEXT_PUBLIC_FACILITATOR_URL: process.env.NEXT_PUBLIC_FACILITATOR_URL ?? process.env.FACILITATOR_URL ?? "http://localhost:4020",
    NEXT_PUBLIC_PUBLISHERS: process.env.NEXT_PUBLIC_PUBLISHERS ?? "http://localhost:4021,http://localhost:4022",
    NEXT_PUBLIC_AUDIT_URL: process.env.NEXT_PUBLIC_AUDIT_URL ?? "http://localhost:3001",
  },
  turbopack: { root: resolve(__dirname, "../..") },
  agentRules: false,
};
export default config;
