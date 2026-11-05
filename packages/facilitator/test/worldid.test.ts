import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { loadConfig } from "../src/config";
import { verifyWorldId, WorldIdError } from "../src/worldid";

const prod = loadConfig({ HEXERA_MODE: "local", WORLD_ID_MODE: "production", WORLD_RP_ID: "rp_test", WORLD_ACTION: "hexera-deposit" });
const dev = loadConfig({ HEXERA_MODE: "local", WORLD_ID_MODE: "dev" });
const realFetch = globalThis.fetch;
let portalCalls = 0;
function portal(success: boolean, status = 200) {
  globalThis.fetch = (async () => {
    portalCalls++;
    return new Response(JSON.stringify({ success }), { status });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
  portalCalls = 0;
});

function v4(account: string, over: Record<string, unknown> = {}, item: Record<string, unknown> = {}) {
  return {
    protocol_version: "4.0",
    nonce: "n",
    action: "hexera-deposit",
    environment: "production",
    responses: [{ identifier: "proof_of_human", signal_hash: hashSignal(account), proof: ["1", "2", "3", "4", "5"], nullifier: "123456789012345678901234567890", issuer_schema_id: 1, expires_at_min: 0, ...item }],
    ...over,
  };
}
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => e instanceof WorldIdError && re.test(e.message));

test("production: reads the human id from responses[].nullifier; same human across accounts", async () => {
  portal(true);
  const a = await verifyWorldId(prod, { result: v4("0.0.1001") }, "0.0.1001");
  const b = await verifyWorldId(prod, { result: v4("0.0.2002") }, "0.0.2002");
  assert.equal(a.human, b.human, "two accounts, one nullifier -> one human");
  const c = await verifyWorldId(prod, { result: v4("0.0.1001", {}, { nullifier: "42" }) }, "0.0.1001");
  assert.notEqual(c.human, a.human);
  assert.equal(portalCalls, 3);
});

test("production: no simulator fallback and strict checks", async () => {
  portal(true);
  await rejects(verifyWorldId(prod, { mode: "dev", human: "alice" }, "0.0.1"), /dev World ID proofs are disabled/);
  await rejects(verifyWorldId(prod, { result: v4("0.0.1", { environment: "staging" }) }, "0.0.1"), /environment/);
  await rejects(verifyWorldId(prod, { result: v4("0.0.1", { protocol_version: "3.0" }) }, "0.0.1"), /4\.0/);
  await rejects(verifyWorldId(prod, { result: v4("0.0.1", { action: "other" }) }, "0.0.1"), /action/);
  await rejects(verifyWorldId(prod, { result: v4("0.0.1") }, "0.0.9"), /signal/);
  await rejects(verifyWorldId(prod, { result: v4("0.0.1", {}, { identifier: "passport" }) }, "0.0.1"), /proof_of_human/);
  await rejects(verifyWorldId(prod, { result: v4("0.0.1", {}, { nullifier: undefined }) }, "0.0.1"), /nullifier/);
  assert.equal(portalCalls, 0, "structurally bad proofs never reach the portal");
  portal(false);
  await rejects(verifyWorldId(prod, { result: v4("0.0.1") }, "0.0.1"), /verification failed/);
  portal(true, 400);
  await rejects(verifyWorldId(prod, { result: v4("0.0.1") }, "0.0.1"), /verification failed/);
});

test("dev mode accepts the simulator only; WORLD_ID_MODE typos fail loudly", async () => {
  assert.ok((await verifyWorldId(dev, { mode: "dev", human: "alice" }, "0.0.1")).human);
  await rejects(verifyWorldId(dev, { result: v4("0.0.1") }, "0.0.1"), /WORLD_ID_MODE=production/);
  assert.throws(() => loadConfig({ HEXERA_MODE: "local", WORLD_ID_MODE: "prod" }), /WORLD_ID_MODE must be/);
  assert.equal(loadConfig({ HEXERA_MODE: "local" }).worldIdMode, "dev");
});
