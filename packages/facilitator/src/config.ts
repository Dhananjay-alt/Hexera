import { resolve } from "node:path";

export interface FacilitatorConfig {
  mode: "local" | "testnet";
  port: number;
  publicUrl: string;
  dataDir: string;
  adminToken: string;

  // Hedera
  network: "testnet" | "mainnet";
  operatorId?: string;
  operatorKey?: string;
  treasuryAccountId?: string;
  treasuryKeys: string[];
  tokenId?: string;
  spentTopicId?: string;
  ledgerTopicId?: string;
  mirrorUrl?: string;

  // Protocol
  epochSeconds: number;
  epochGraceSeconds: number;
  payoutIntervalSeconds: number;
  maxIssuePerCall: number;

  // Spending controls
  freeDailyLimitBase: bigint;
  humanDailyCapBase: bigint;

  // World ID
  worldIdMode: "dev" | "production";
  worldAppId?: string;
  worldRpId?: string;
  worldRpSigningKey?: string;
  worldAction: string;

  /** "id:account:Display Name" entries, comma separated */
  merchants: { id: string; account?: string; name: string }[];
}

const num = (v: string | undefined, d: number) => (v ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const mode = (env.HEXERA_MODE ?? "local") as "local" | "testnet";
  const port = num(env.FACILITATOR_PORT ?? env.PORT, 4020);
  const cfg: FacilitatorConfig = {
    mode,
    port,
    publicUrl: env.FACILITATOR_URL ?? `http://localhost:${port}`,
    dataDir: resolve(env.HEXERA_DATA_DIR ?? "data"),
    adminToken: env.ADMIN_TOKEN ?? "dev-admin-token",

    network: (env.HEDERA_NETWORK ?? "testnet") as "testnet" | "mainnet",
    operatorId: env.HEDERA_OPERATOR_ID,
    operatorKey: env.HEDERA_OPERATOR_KEY,
    treasuryAccountId: env.HEXERA_TREASURY_ID,
    treasuryKeys: (env.HEXERA_TREASURY_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    tokenId: env.HEXERA_TOKEN_ID,
    spentTopicId: env.HEXERA_SPENT_TOPIC_ID,
    ledgerTopicId: env.HEXERA_LEDGER_TOPIC_ID,
    mirrorUrl: env.HEDERA_MIRROR_URL,

    epochSeconds: num(env.EPOCH_SECONDS, 86_400),
    epochGraceSeconds: num(env.EPOCH_GRACE_SECONDS, 86_400),
    payoutIntervalSeconds: num(env.PAYOUT_INTERVAL_SECONDS, 180),
    maxIssuePerCall: num(env.MAX_ISSUE_PER_CALL, 500),

    freeDailyLimitBase: BigInt(env.FREE_DAILY_LIMIT_BASE ?? "1000000"), // $1/account/day without World ID
    humanDailyCapBase: BigInt(env.HUMAN_DAILY_CAP_BASE ?? "20000000"), // $20/human/day

    worldIdMode: (env.WORLD_ID_MODE ?? (mode === "local" ? "dev" : "production")) as "dev" | "production",
    worldAppId: env.WORLD_APP_ID,
    worldRpId: env.WORLD_RP_ID,
    worldRpSigningKey: env.WORLD_RP_SIGNING_KEY,
    worldAction: env.WORLD_ACTION ?? "hexera-deposit",

    merchants: (env.HEXERA_MERCHANTS ?? "daily-ledger::The Daily Ledger,quant-feed::Quant Feed")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [id, account, ...name] = s.split(":");
        return { id, account: account || undefined, name: name.join(":") || id };
      }),
  };

  if (mode === "testnet") {
    const missing = (
      ["operatorId", "operatorKey", "treasuryAccountId", "tokenId", "spentTopicId", "ledgerTopicId"] as const
    ).filter((k) => !cfg[k]);
    if (missing.length) throw new Error(`testnet mode needs: ${missing.join(", ")} (run npm run setup:testnet)`);
    if (cfg.treasuryKeys.length === 0) throw new Error("testnet mode needs HEXERA_TREASURY_KEYS");
    if (cfg.merchants.some((m) => !m.account)) throw new Error("testnet mode needs an account id for every merchant in HEXERA_MERCHANTS");
  }
  return cfg;
}
