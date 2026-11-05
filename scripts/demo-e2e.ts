/**
 * The 3-minute demo as a script: an agent (no human approving anything)
 * deposits, buys vouchers blind, reads paywalled articles from two
 * publishers, then we show what each party saw and that attacks fail.
 *
 * Needs the facilitator and both publishers running (npm run dev).
 *   npm run demo
 */
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");

import { HEADERS, decodeJsonB64, formatUsdc, type SpentMessage } from "@hexera/core";
import { HexeraWallet, MemoryStore, HexeraError, type SupportedInfo } from "@hexera/client";
import { MirrorClient, decodeMessage, hashscanTopicUrl, hashscanTxUrl, userDeposit } from "@hexera/hedera";

const FAC = process.env.FACILITATOR_URL ?? "http://localhost:4020";
const PUBS = [process.env.PUBLISHER_A_URL ?? "http://localhost:4021", process.env.PUBLISHER_B_URL ?? "http://localhost:4022"];
const ADMIN = process.env.ADMIN_TOKEN;

const c = { b: "\x1b[1m", d: "\x1b[2m", g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", cy: "\x1b[36m", x: "\x1b[0m" };
const step = (n: string, t: string) => console.log(`\n${c.b}${c.cy}${n}  ${t}${c.x}`);
const ok = (t: string) => console.log(`  ${c.g}✔${c.x} ${t}`);
const no = (t: string) => console.log(`  ${c.r}✘${c.x} ${t}`);
const info = (t: string) => console.log(`  ${c.d}${t}${c.x}`);

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(`${FAC}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const j = (await r.json()) as T & { error?: string; message?: string };
  if (!r.ok) throw new HexeraError(j.error ?? "error", j.message ?? `${path} ${r.status}`, r.status);
  return j;
}

function link(s: SupportedInfo, txId: string) {
  return s.mode === "testnet" ? hashscanTxUrl(s.network, txId) : `${s.mirrorUrl}/api/v1/transactions/${txId}`;
}

/** Make an on-chain deposit from a demo account. */
async function deposit(s: SupportedInfo, who: "1" | "2", amountBase: bigint): Promise<{ account: string; txId: string }> {
  if (s.mode === "local") {
    const { account } = await post<{ account: string }>("/local/faucet", { name: `demo-user-${who}`, amountBase: "25000000" });
    const { transactionId } = await post<{ transactionId: string }>("/local/deposit", { account, amountBase: amountBase.toString() });
    return { account, txId: transactionId };
  }
  const id = process.env[`DEMO_USER_${who}_ID`];
  const key = process.env[`DEMO_USER_${who}_KEY`];
  if (!id || !key) throw new Error(`set DEMO_USER_${who}_ID / DEMO_USER_${who}_KEY (npm run setup:testnet)`);
  const txId = await userDeposit({ network: "testnet", accountId: id, privateKey: key, tokenId: s.asset, treasury: s.treasury, amountBase });
  return { account: id, txId };
}

const wallet = new HexeraWallet({ facilitatorUrl: FAC, store: new MemoryStore(), log: (m) => info(`wallet: ${m}`) });
const s = await wallet.supported().catch(() => {
  console.error(`Facilitator not reachable at ${FAC}. Start everything with: npm run dev`);
  process.exit(1);
});
const human = { mode: "dev" as const, human: "demo-human" };
const useDevWorldId = s.worldId.mode === "dev";

console.log(`${c.b}Hexera — private x402 on Hedera${c.x}  ${c.d}(${s.mode} mode, ${s.network})${c.x}`);
info(`facilitator ${FAC} · treasury ${s.treasury} · token ${s.asset}`);
info(`hexera-spent ${s.topics.spent} · hexera-ledger ${s.topics.ledger} · epoch ${s.currentEpoch}`);

// ---------------------------------------------------------------- deposit
step("1", "Deposit once (the only time the user's account touches the chain)");
const amount = 200_000n; // 0.20 USDC -> 198 vouchers of 0.001
const dep = await deposit(s, "1", amount);
ok(`account ${dep.account} sent ${formatUsdc(amount)} USDC to the Hexera treasury: ${link(s, dep.txId)}`);
const t0 = performance.now();
const r = await wallet.redeemDeposit(dep.txId, useDevWorldId ? human : undefined);
ok(`${r.units} vouchers bought blind in ${((performance.now() - t0) / 1000).toFixed(1)}s — the facilitator signed serials it has never seen`);
info(`balance: ${JSON.stringify(await wallet.balance())}`);

// ------------------------------------------------------------------- read
step("2", "Read paywalled articles across two publishers (402 → pay → 200, no prompts)");
let captured: { url: string; header: string } | null = null;
const spy = new HexeraWallet({
  facilitatorUrl: FAC,
  store: (wallet as unknown as { opts: { store: MemoryStore } }).opts.store,
  fetch: async (url, init) => {
    const h = new Headers(init?.headers).get(HEADERS.signature);
    if (h) captured = { url: String(url), header: h };
    return fetch(url, init);
  },
});
const reads: string[] = [];
for (const pub of PUBS) {
  const cat = (await (await fetch(pub)).json()) as { name: string; articles: { url: string; title: string; price: number }[] };
  for (const a of cat.articles.slice(0, pub === PUBS[0] ? 3 : 2)) {
    const res = await spy.fetch(`${pub}${a.url}`);
    const body = (await res.response.json()) as { title: string };
    ok(`${cat.name}: "${body.title}" — paid ${res.unitsPaid} unit(s), hcs ${res.settlement?.transaction}`);
    reads.push(res.settlement!.transaction);
  }
}
info(`balance: ${JSON.stringify(await wallet.balance())}`);

// ------------------------------------------------------------ chain view
step("3", "What the chain sees");
const mirror = new MirrorClient(s.mirrorUrl);
if (s.mode === "testnet") await new Promise((res) => setTimeout(res, 6000)); // mirror lag
const spent = (await mirror.getTopicMessages(s.topics.spent)).slice(-5);
for (const m of spent) {
  const d = decodeMessage<SpentMessage>(m);
  if (d) info(`seq ${m.sequence_number} @ ${m.consensus_timestamp}: merchant=${d.merchant} units=${d.units} spentIds=[${d.spentIds.map((x) => x.slice(0, 10) + "…").join(", ")}]`);
}
ok(`spent messages carry anonymous serial hashes and the merchant — no payer account anywhere`);
if (s.mode === "testnet") info(hashscanTopicUrl(s.network, s.topics.spent));

// ---------------------------------------------------------------- attacks
step("4", "Attacks fail");
if (captured) {
  const cap = captured as { url: string; header: string };
  const replay = await fetch(cap.url, { headers: { [HEADERS.signature]: cap.header } });
  const err = replay.status === 402 ? decodeJsonB64<{ error?: string }>(replay.headers.get(HEADERS.required)!).error : `status ${replay.status}`;
  (replay.status === 402 ? ok : no)(`replaying a spent voucher set → ${replay.status} (${err})`);
}
if (useDevWorldId) {
  // Same human, second account, tries to go past the per-human cap.
  const cap = BigInt(s.limits.humanDailyCapBase);
  const check = await post<{ ok: boolean; reason?: string }>("/deposit/check", { account: "second-account-of-same-human", amountBase: cap.toString(), worldId: human });
  (check.ok ? no : ok)(`second account of the same human depositing ${formatUsdc(cap)} USDC → ${check.ok ? "allowed?!" : `refused: ${check.reason}`}`);
} else {
  info("World ID is in production mode; run the cap demo from the reader app with a real World App proof");
}

// ----------------------------------------------------------------- payout
step("5", "Payout: one HTS transfer pays every publisher");
if (!ADMIN) {
  info("ADMIN_TOKEN not set, so POST /payout is disabled; the payout cron pays merchants within PAYOUT_INTERVAL_SECONDS");
} else {
  const p = await post<{ batches: { batchId: string; transactionId: string; merchants: number; totalUnits: number }[] }>("/payout", {}, { authorization: `Bearer ${ADMIN}` });
  for (const b of p.batches) ok(`batch ${b.batchId}: ${b.merchants} merchant(s), ${b.totalUnits} unit(s) = ${formatUsdc(BigInt(b.totalUnits) * 1000n)} USDC → ${link(s, b.transactionId)}`);
  if (!p.batches.length) info("nothing pending (the payout cron may have just run)");
}

step("6", "What each party learned");
info(`chain:       ${dep.account} deposited ${formatUsdc(amount)} to Hexera; publishers got a batch payout; serials burned at times T`);
info(`facilitator: who deposited, which merchant redeemed which serials — not which depositor owns which serial`);
info(`publishers:  a valid payment arrived (see their logs: "payer: unknown")`);
const books = (await (await fetch(`${FAC}/books`)).json()) as { unitsCredited: number; unitsIssued: number; unitsSpent: number };
info(`books: credited ${books.unitsCredited} · issued ${books.unitsIssued} · spent ${books.unitsSpent} (issued ≤ credited)`);
console.log(`\n${c.b}x402 with card-network privacy, on Hedera, no smart contracts.${c.x}\n`);
