import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blindNewVoucher,
  blindSign,
  computeRequestHash,
  decodeJsonB64,
  encodeJsonB64,
  exportPublicKey,
  finalizeVoucher,
  generateEpochKey,
  importPublicKey,
  isVoucher,
  verifyVoucherSig,
  fromHex,
  fromBase64,
  toBase64,
} from "../src/index";
import { RSABSSA } from "@cloudflare/blindrsa-ts";

test("blind RSA voucher round trip (RFC 9474)", async () => {
  const kp = await generateEpochKey(1);
  const pub = await importPublicKey(await exportPublicKey(kp.publicKey));
  const b = await blindNewVoucher(pub);
  const blindSig = await blindSign(kp.privateKey, b.blindedMsg);
  const sig = await finalizeVoucher(pub, b, blindSig);
  const v = { epoch: 1, serial: b.serial, sig };
  assert.ok(isVoucher(v));
  assert.equal(await verifyVoucherSig(pub, v.serial, v.sig), true);
  // The facilitator only ever saw blindedMsg; it differs from the serial.
  assert.notEqual(b.blindedMsg, Buffer.from(b.serial, "hex").toString("base64"));
  // Tampered serial fails.
  const bad = (v.serial[0] === "a" ? "b" : "a") + v.serial.slice(1);
  assert.equal(await verifyVoucherSig(pub, bad, v.sig), false);
  // Another key's signature fails.
  const other = await generateEpochKey(2);
  assert.equal(await verifyVoucherSig(other.publicKey, v.serial, v.sig), false);
  // Wrong blind signature is rejected at finalize.
  await assert.rejects(finalizeVoucher(pub, b, await blindSign(other.privateKey, (await blindNewVoucher(other.publicKey)).blindedMsg)));
});

test("native-BigInt Blind interoperates with blindrsa-ts (both directions of the library)", async () => {
  const kp = await generateEpochKey(3);
  for (const useLibrary of [false, true, false, false]) {
    const b = await blindNewVoucher(kp.publicKey, useLibrary);
    const blindSig = await blindSign(kp.privateKey, b.blindedMsg);
    const sig = await finalizeVoucher(kp.publicKey, b, blindSig); // fast path; throws if invalid
    assert.equal(await verifyVoucherSig(kp.publicKey, b.serial, sig), true);
    const libSig = await RSABSSA.SHA384.PSS.Randomized().finalize(kp.publicKey, fromHex(b.serial), fromBase64(blindSig), fromBase64(b.inv));
    assert.equal(toBase64(libSig), sig, "fast finalize == library finalize");
  }
});

test("request hash binds method, path and body", async () => {
  const a = await computeRequestHash("GET", "/articles/x");
  assert.equal(a, await computeRequestHash("get", "/articles/x", ""));
  assert.notEqual(a, await computeRequestHash("GET", "/articles/y"));
  assert.notEqual(await computeRequestHash("POST", "/q", "{}"), await computeRequestHash("POST", "/q", "{ }"));
});

test("header codec is unicode safe", () => {
  const v = { name: "Daily Ledger — ₹", n: 1 };
  assert.deepEqual(decodeJsonB64(encodeJsonB64(v)), v);
});
