import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { FastifyInstance } from "fastify";
import { HEADERS, decodeJsonB64, encodeJsonB64, type HexeraPaymentPayload } from "@hexera/core";
import { HexeraMerchant, hexeraPaywall, x402Cors } from "@hexera/server";
import { HexeraWallet, MemoryStore, HexeraError } from "@hexera/client";
import { buildApp, Facilitator, loadConfig } from "../src/index";

let dir: string;
let f: Facilitator;
let fapp: FastifyInstance;
let fUrl: string;
let pub: Server;
let pubUrl: string;
const silent = { info() {}, warn() {}, error() {} };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "hexera-test-"));
  const cfg = loadConfig({ HEXERA_MODE: "local", HEXERA_DATA_DIR: dir, FREE_DAILY_LIMIT_BASE: "100000", HUMAN_DAILY_CAP_BASE: "300000" });
  f = await Facilitator.create(cfg, silent);
  fapp = await buildApp(f);
  await fapp.listen({ port: 0, host: "127.0.0.1" });
  fUrl = `http://127.0.0.1:${(fapp.server.address() as AddressInfo).port}`;
  f.cfg.publicUrl = fUrl;

  const merchant = new HexeraMerchant({ facilitatorUrl: fUrl, merchantId: "daily-ledger", log: () => {} });
  const app = express();
  app.use(x402Cors());
  app.get("/free", (_q, r) => r.json({ ok: true }));
  app.get("/article/:id", hexeraPaywall(merchant, { price: 3 }), (req, res) => res.json({ article: req.params.id }));
  await new Promise<void>((r) => (pub = app.listen(0, "127.0.0.1", () => r())));
  pubUrl = `http://127.0.0.1:${(pub.address() as AddressInfo).port}`;
});

after(async () => {
  pub?.close();
  await fapp?.close();
  await f?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${fUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json()) as T;
}

async function fundedWallet(name: string, depositBase: string, worldId?: { mode: "dev"; human: string }) {
  const { account } = await post<{ account: string }>("/local/faucet", { name, amountBase: "50000000" });
  const { transactionId } = await post<{ transactionId: string }>("/local/deposit", { account, amountBase: depositBase });
  const wallet = new HexeraWallet({ facilitatorUrl: fUrl, store: new MemoryStore() });
  return { wallet, account, transactionId, redeem: () => wallet.redeemDeposit(transactionId, worldId) };
}

test("deposit -> blind issue -> 402 -> pay -> burn on HCS -> payout", async () => {
  const { wallet, redeem } = await fundedWallet("alice-1", "20200"); // 0.0202 USDC -> 20 vouchers
  const r = await redeem();
  assert.equal(r.units, 20);
  assert.equal((await wallet.balance()).units, 20);

  const free = await wallet.fetch(`${pubUrl}/free`);
  assert.equal(free.unitsPaid, 0);

  const unpaid = await fetch(`${pubUrl}/article/1`);
  assert.equal(unpaid.status, 402);
  const pr = decodeJsonB64<{ accepts: { scheme: string; amount: string }[] }>(unpaid.headers.get(HEADERS.required)!);
  assert.equal(pr.accepts[0].scheme, "hexera-ecash");
  assert.equal(pr.accepts[0].amount, "3");

  const paid = await wallet.fetch(`${pubUrl}/article/1`);
  assert.equal(paid.response.status, 200);
  assert.deepEqual(await paid.response.json(), { article: "1" });
  assert.equal(paid.unitsPaid, 3);
  assert.equal(paid.settlement?.success, true);
  assert.equal((paid.settlement as unknown as Record<string, unknown>).payer, undefined, "no payer field, on purpose");
  assert.equal((await wallet.balance()).units, 17);

  // The burn is public on hexera-spent.
  const msgs = await f.backend.mirror.getTopicMessages(f.ids.spentTopic);
  const last = JSON.parse(Buffer.from(msgs.at(-1)!.message, "base64").toString());
  assert.equal(last.t, "spent");
  assert.equal(last.spentIds.length, 3);
  assert.equal(last.merchant, "daily-ledger");
  assert.ok(!JSON.stringify(last).includes("alice"));

  const payout = await f.payout();
  assert.equal(payout?.batches.length, 1);
  const merchantAcct = f.merchants().find((m) => m.id === "daily-ledger")!.account;
  assert.equal(f.local!.balance(merchantAcct, f.ids.token), 3000n);
});

test("replayed vouchers are refused", async () => {
  const { wallet, redeem } = await fundedWallet("bob", "10100");
  await redeem();
  // Capture a payment header by intercepting the paid request.
  let captured: string | null = null;
  const spy = new HexeraWallet({
    facilitatorUrl: fUrl,
    store: (wallet as unknown as { opts: { store: MemoryStore } }).opts.store,
    fetch: async (url, init) => {
      const h = new Headers(init?.headers).get(HEADERS.signature);
      if (h) captured = h;
      return fetch(url, init);
    },
  });
  const ok = await spy.fetch(`${pubUrl}/article/2`);
  assert.equal(ok.response.status, 200);
  assert.ok(captured);

  const replay = await fetch(`${pubUrl}/article/2`, { headers: { [HEADERS.signature]: captured! } });
  assert.equal(replay.status, 402);
  assert.equal(decodeJsonB64<{ error: string }>(replay.headers.get(HEADERS.required)!).error, "voucher_already_spent");

  // Lifting the same (fresh) payment onto another URL fails on requestHash.
  const p = decodeJsonB64<HexeraPaymentPayload>(captured!);
  const lifted = await fetch(`${pubUrl}/article/3`, { headers: { [HEADERS.signature]: encodeJsonB64(p) } });
  assert.equal(lifted.status, 402);
  assert.match(decodeJsonB64<{ error: string }>(lifted.headers.get(HEADERS.required)!).error, /requestHash/);
});

test("forged vouchers are refused", async () => {
  const unpaid = await fetch(`${pubUrl}/article/9`);
  const pr = decodeJsonB64<{ accepts: HexeraPaymentPayload["accepted"][] }>(unpaid.headers.get(HEADERS.required)!);
  const { computeRequestHash } = await import("@hexera/core");
  const fake = { epoch: pr.accepts[0].extra.epoch, serial: "ab".repeat(64), sig: Buffer.alloc(256, 7).toString("base64") };
  const payload = { x402Version: 2, accepted: pr.accepts[0], payload: { vouchers: [fake, { ...fake, serial: "cd".repeat(64) }, { ...fake, serial: "ef".repeat(64) }], requestHash: await computeRequestHash("GET", "/article/9") } };
  const r = await fetch(`${pubUrl}/article/9`, { headers: { [HEADERS.signature]: encodeJsonB64(payload) } });
  assert.equal(r.status, 402);
  assert.equal(decodeJsonB64<{ error: string }>(r.headers.get(HEADERS.required)!).error, "invalid_signature");
});

test("World ID: deposits above the free limit need a human; the cap is per human, not per account", async () => {
  // 0.2 USDC > 0.1 USDC free limit -> needs World ID
  const a = await fundedWallet("carol-1", "200000");
  await assert.rejects(a.redeem(), (e: HexeraError) => e.code === "world_id_required");
  const ok = await a.wallet.redeemDeposit(a.transactionId, { mode: "dev", human: "carol" });
  assert.equal(ok.units, Math.floor(200_000 / 1010));

  // Same human, second account: 0.2 + 0.2 > 0.3 USDC cap -> refused and refunded.
  const b = await fundedWallet("carol-2", "200000", { mode: "dev", human: "carol" });
  await assert.rejects(b.redeem(), (e: HexeraError) => e.code === "human_cap_exceeded");
  const before = f.local!.balance(b.account, f.ids.token);
  await f.payout();
  assert.equal(f.local!.balance(b.account, f.ids.token), before + 200_000n, "refunded");

  // A different human is fine.
  const d = await fundedWallet("dave", "50500", { mode: "dev", human: "dave" });
  assert.ok((await d.redeem()).units > 0);
});

test("a deposit can only be redeemed once", async () => {
  const a = await fundedWallet("erin", "20200");
  await a.redeem();
  await assert.rejects(a.wallet.redeemDeposit(a.transactionId), (e: HexeraError) => e.code === "deposit_already_used");
});

test("books balance: issued <= credited, treasury covers outstanding vouchers", async () => {
  const b = await f.books();
  assert.ok(b.unitsIssued <= b.unitsCredited);
  const outstanding = BigInt(b.unitsIssued - b.unitsSpent) * 1000n;
  assert.ok(BigInt(b.treasuryBalanceBase!) >= outstanding);
});

test("a stale 'key published' flag can't hide the key: it is re-published if missing from HCS", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "hexera-stale-"));
  try {
    const cfg2 = loadConfig({ HEXERA_MODE: "local", HEXERA_DATA_DIR: dir2 });
    const { Db } = await import("../src/db");
    const epoch = Math.floor(Date.now() / 1000 / cfg2.epochSeconds);
    new Db(join(cfg2.dataDir, "facilitator.sqlite")).set(`key_published:${epoch}`, "1"); // left over, but the topic is empty
    const f3 = await Facilitator.create(cfg2, silent);
    const keys = await f3.syncLedger();
    assert.equal(keys.size, 1, "epoch key is on hexera-ledger");
    await f3.close();
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});
