import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Load ./.env (repo root) if present, without overriding real env vars. */
export function loadEnv(file = resolve(process.cwd(), ".env")) {
  if (existsSync(file)) process.loadEnvFile(file);
}
