import { loadEnv } from "./env";
loadEnv();

import { buildApp } from "./app";
import { loadConfig } from "./config";
import { Facilitator } from "./service";

const cfg = loadConfig();
const f = await Facilitator.create(cfg);
const app = await buildApp(f);
await app.listen({ port: cfg.port, host: "0.0.0.0" });

const s = await f.supported();
f.log.info(`listening on ${cfg.publicUrl} — mode=${cfg.mode} network=${s.hexera.network}`);
f.log.info(`treasury=${f.ids.treasury} token=${f.ids.token} hexera-spent=${f.ids.spentTopic} hexera-ledger=${f.ids.ledgerTopic}`);
f.log.info(`epoch ${s.hexera.currentEpoch} key fingerprint ${s.hexera.keys[0]?.fingerprint}`);
if (!cfg.adminToken) f.log.warn("ADMIN_TOKEN not set: POST /payout and /admin/refund are disabled (the payout cron still runs)");
f.log.info(`merchants: ${f.merchants().map((m) => `${m.id}(${m.account})`).join(", ")}`);

const payoutTimer = setInterval(() => {
  f.payout().catch((e) => f.log.error(`payout: ${e.message}`));
}, cfg.payoutIntervalSeconds * 1000);
const syncTimer =
  cfg.mode === "testnet"
    ? setInterval(() => f.syncSpent().catch((e) => f.log.warn(`sync: ${e.message}`)), 15_000)
    : undefined;

const shutdown = async () => {
  clearInterval(payoutTimer);
  if (syncTimer) clearInterval(syncTimer);
  await app.close();
  await f.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
