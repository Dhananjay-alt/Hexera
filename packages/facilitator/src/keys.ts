import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NativeBlindSigner } from "./nativeSign";
import {
  BLIND_SUITE_NAME,
  exportPrivateKeyJwk,
  exportPublicKey,
  generateEpochKey,
  importPrivateKeyJwk,
  importPublicKey,
  keyFingerprint,
} from "@hexera/core";

export interface EpochKey {
  epoch: number;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** native RFC 9474 BlindSign */
  signer: NativeBlindSigner;
  publicKeyB64: string;
  fingerprint: string;
  validFrom: Date;
  /** last moment a voucher of this epoch can be spent or exchanged */
  validTo: Date;
}

/**
 * One RSA-2048 blind-signing key per epoch. Every user gets vouchers from the
 * same key (published on HCS) so the facilitator can't tag users with
 * per-user keys. In production the private keys belong in an HSM / separate
 * signer service, not on the payout server.
 */
export class EpochKeys {
  private cache = new Map<number, EpochKey>();

  constructor(
    private dir: string,
    private epochSeconds: number,
    private graceSeconds: number,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  epochAt(ms = Date.now()) {
    return Math.floor(ms / 1000 / this.epochSeconds);
  }

  windowOf(epoch: number) {
    const validFrom = new Date(epoch * this.epochSeconds * 1000);
    const validTo = new Date(((epoch + 1) * this.epochSeconds + this.graceSeconds) * 1000);
    return { validFrom, validTo };
  }

  /** True if vouchers of `epoch` may still be spent now. */
  isSpendable(epoch: number, now = Date.now()) {
    return epoch <= this.epochAt(now) && now < this.windowOf(epoch).validTo.getTime();
  }

  async current(): Promise<{ key: EpochKey; created: boolean }> {
    return this.load(this.epochAt(), true) as Promise<{ key: EpochKey; created: boolean }>;
  }

  async get(epoch: number): Promise<EpochKey | null> {
    return (await this.load(epoch, false))?.key ?? null;
  }

  /** Keys whose vouchers are still spendable (current + those in grace). */
  async active(): Promise<EpochKey[]> {
    const cur = this.epochAt();
    const out: EpochKey[] = [];
    for (let e = cur; e >= 0 && e >= cur - Math.ceil(this.graceSeconds / this.epochSeconds) - 1; e--) {
      const k = await this.get(e);
      if (k && this.isSpendable(e)) out.push(k);
    }
    return out;
  }

  private async load(epoch: number, create: boolean) {
    const hit = this.cache.get(epoch);
    if (hit) return { key: hit, created: false };
    const file = join(this.dir, `epoch-${epoch}.json`);
    let created = false;
    let privateJwk: JsonWebKey;
    let publicKeyB64: string;
    if (existsSync(file)) {
      ({ privateJwk, publicKeyB64 } = JSON.parse(readFileSync(file, "utf8")));
    } else {
      if (!create) return null;
      const kp = await generateEpochKey(epoch);
      privateJwk = await exportPrivateKeyJwk(kp.privateKey);
      publicKeyB64 = await exportPublicKey(kp.publicKey);
      writeFileSync(file, JSON.stringify({ epoch, suite: BLIND_SUITE_NAME, privateJwk, publicKeyB64 }), { mode: 0o600 });
      created = true;
    }
    const key: EpochKey = {
      epoch,
      privateKey: await importPrivateKeyJwk(privateJwk),
      signer: new NativeBlindSigner(privateJwk),
      publicKey: await importPublicKey(publicKeyB64),
      publicKeyB64,
      fingerprint: await keyFingerprint(publicKeyB64),
      ...this.windowOf(epoch),
    };
    this.cache.set(epoch, key);
    return { key, created };
  }
}
