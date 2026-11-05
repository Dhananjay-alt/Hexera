/**
 * Serves the audit page. It reads only the mirror node (public data); the
 * facilitator is used only as a fallback to discover topic ids when they are
 * not configured here.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

if (existsSync(".env")) process.loadEnvFile(".env");
const dir = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.AUDIT_PORT ?? 3001);
const mode = process.env.HEXERA_MODE ?? "local";
const facilitator = process.env.FACILITATOR_URL ?? "http://localhost:4020";
const config = {
  network: mode === "testnet" ? `hedera:${process.env.HEDERA_NETWORK ?? "testnet"}` : "hedera:local",
  mirrorUrl: mode === "testnet" ? (process.env.HEDERA_MIRROR_URL ?? `https://${process.env.HEDERA_NETWORK ?? "testnet"}.mirrornode.hedera.com`) : facilitator,
  // Testnet topic ids only make sense against the testnet mirror; in local mode the page discovers them from the facilitator.
  spentTopic: mode === "testnet" ? (process.env.HEXERA_SPENT_TOPIC_ID ?? null) : null,
  ledgerTopic: mode === "testnet" ? (process.env.HEXERA_LEDGER_TOPIC_ID ?? null) : null,
  facilitator,
};

const files: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/audit.js": ["audit.js", "text/javascript; charset=utf-8"],
};
// Geist is served from the local geist package: no font CDN, no third-party requests.
const require = createRequire(import.meta.url);
const geistFonts = join(dirname(require.resolve("geist/font/sans")), "fonts");
const fonts: Record<string, string> = {
  "/fonts/Geist-Variable.woff2": join(geistFonts, "geist-sans", "Geist-Variable.woff2"),
  "/fonts/GeistMono-Variable.woff2": join(geistFonts, "geist-mono", "GeistMono-Variable.woff2"),
};

createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/config.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(config));
  }
  if (fonts[path]) {
    res.writeHead(200, { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" });
    return res.end(readFileSync(fonts[path]));
  }
  const f = files[path];
  if (!f) {
    res.writeHead(404);
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": f[1], "cache-control": "no-store" });
  res.end(readFileSync(join(dir, f[0])));
}).listen(port, () => console.log(`[audit] http://localhost:${port} (mirror ${config.mirrorUrl})`));
