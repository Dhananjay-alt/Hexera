/** Before-the-event check: blind -> sign -> finalize -> verify, plus timings. */
import { blindNewVoucher, blindSign, finalizeVoucher, generateEpochKey, verifyVoucherSig, BLIND_SUITE_NAME } from "@hexera/core";

const kp = await generateEpochKey(0);
const t0 = performance.now();
const b = await blindNewVoucher(kp.publicKey);
const t1 = performance.now();
const blindSig = await blindSign(kp.privateKey, b.blindedMsg);
const t2 = performance.now();
const sig = await finalizeVoucher(kp.publicKey, b, blindSig);
const t3 = performance.now();
const ok = await verifyVoucherSig(kp.publicKey, b.serial, sig);
console.log(`${BLIND_SUITE_NAME}: ${ok ? "OK" : "FAILED"}`);
console.log(`  blind ${(t1 - t0).toFixed(1)} ms · blindSign (pure JS) ${(t2 - t1).toFixed(1)} ms · finalize ${(t3 - t2).toFixed(1)} ms`);
console.log(`  serial ${b.serial.slice(0, 24)}…  sig ${sig.slice(0, 24)}…`);
process.exit(ok ? 0 : 1);
