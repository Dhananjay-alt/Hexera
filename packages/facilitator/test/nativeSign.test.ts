import { test } from "node:test";
import assert from "node:assert/strict";
import { blindNewVoucher, blindSign, exportPrivateKeyJwk, finalizeVoucher, fromBase64, generateEpochKey, toBase64, verifyVoucherSig } from "@hexera/core";
import { NativeBlindSigner } from "../src/nativeSign";

test("native BlindSign is byte-for-byte identical to blindrsa-ts and verifies", async () => {
  const kp = await generateEpochKey(7);
  const jwk = await exportPrivateKeyJwk(kp.privateKey);
  for (const k of ["p", "q", "dp", "dq", "qi"]) assert.ok((jwk as Record<string, unknown>)[k], `JWK carries CRT parameter ${k}`);
  const signer = new NativeBlindSigner(jwk);
  for (let i = 0; i < 5; i++) {
    const b = await blindNewVoucher(kp.publicKey);
    const native = signer.sign(b.blindedMsg);
    assert.equal(native, await blindSign(kp.privateKey, b.blindedMsg), "RSASP1 is deterministic: same bytes as the library");
    const sig = await finalizeVoucher(kp.publicKey, b, native);
    assert.equal(await verifyVoucherSig(kp.publicKey, b.serial, sig), true);
  }
});

test("native BlindSign rejects malformed blinded messages", async () => {
  const kp = await generateEpochKey(8);
  const signer = new NativeBlindSigner(await exportPrivateKeyJwk(kp.privateKey));
  assert.throws(() => signer.sign(toBase64(new Uint8Array(255).fill(1))), /wrong length/);
  assert.throws(() => signer.sign(toBase64(new Uint8Array(256).fill(0xff)))); // >= n
  assert.equal(fromBase64(signer.sign(toBase64(new Uint8Array(256).fill(1)))).length, 256);
});
