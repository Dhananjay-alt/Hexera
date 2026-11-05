/**
 * Thin wrapper over @cloudflare/blindrsa-ts, RSABSSA-SHA384-PSS-Randomized
 * (RFC 9474), 2048-bit keys.
 *
 * Note on "serial": the Randomized variant prepends 32 random bytes to the
 * client's message during prepare(). The signature covers that prepared
 * message, so on the wire `serial` is hex(prepared message) = 32-byte random
 * prefix || 32-byte random client serial. Both halves are client randomness
 * the facilitator never sees before spending.
 */
import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { fromBase64, randomBytes, sha256Hex, toBase64, toHex, fromHex } from "./bytes";

const suite = () => RSABSSA.SHA384.PSS.Randomized();

export const BLIND_SUITE_NAME = "RSABSSA-SHA384-PSS-Randomized";
const ALG = { name: "RSA-PSS", hash: "SHA-384" } as const;

export interface EpochKeyPair {
  epoch: number;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export async function generateEpochKey(epoch: number): Promise<EpochKeyPair> {
  const { privateKey, publicKey } = await suite().generateKey({
    publicExponent: Uint8Array.from([1, 0, 1]),
    modulusLength: 2048,
  });
  return { epoch, privateKey, publicKey };
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
}

export async function exportPrivateKeyJwk(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", key);
}

export async function importPublicKey(spkiB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", fromBase64(spkiB64) as BufferSource, ALG, true, ["verify"]);
}

export async function importPrivateKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ALG, true, ["sign"]);
}

/** Short public fingerprint of an epoch key, published on hexera-ledger. */
export async function keyFingerprint(spkiB64: string): Promise<string> {
  return (await sha256Hex(fromBase64(spkiB64))).slice(0, 32);
}

export interface BlindedVoucher {
  /** hex prepared message (becomes the voucher serial) */
  serial: string;
  /** base64 blinded message sent to the facilitator */
  blindedMsg: string;
  /** base64 inverse, kept secret by the client */
  inv: string;
}

export async function blindNewVoucher(publicKey: CryptoKey): Promise<BlindedVoucher> {
  const s = suite();
  const prepared = s.prepare(randomBytes(32));
  const { blindedMsg, inv } = await s.blind(publicKey, prepared);
  return { serial: toHex(prepared), blindedMsg: toBase64(blindedMsg), inv: toBase64(inv) };
}

export async function blindSign(privateKey: CryptoKey, blindedMsgB64: string): Promise<string> {
  const sig = await suite().blindSign(privateKey, fromBase64(blindedMsgB64));
  return toBase64(sig);
}

/** Unblind; throws if the facilitator's signature does not verify. */
export async function finalizeVoucher(
  publicKey: CryptoKey,
  blinded: BlindedVoucher,
  blindSigB64: string,
): Promise<string> {
  const sig = await suite().finalize(
    publicKey,
    fromHex(blinded.serial),
    fromBase64(blindSigB64),
    fromBase64(blinded.inv),
  );
  return toBase64(sig);
}

export async function verifyVoucherSig(publicKey: CryptoKey, serialHex: string, sigB64: string): Promise<boolean> {
  try {
    return await suite().verify(publicKey, fromBase64(sigB64), fromHex(serialHex));
  } catch {
    return false;
  }
}
