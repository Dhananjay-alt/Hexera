import { constants, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, type KeyObject } from "node:crypto";
import { fromBase64, toBase64 } from "@hexera/core";

/**
 * RFC 9474 BlindSign using OpenSSL's raw RSA, ~100x faster than blindrsa-ts:
 *   s  = RSASP1(sk, m)   -> privateDecrypt, RSA_NO_PADDING
 *   m' = RSAVP1(pk, s)   -> publicEncrypt, RSA_NO_PADDING
 *   require m == m'      (RFC 9474 step 4; every signature is checked before it is returned)
 *
 * Inside privateDecrypt, OpenSSL (3.5.x, crypto/rsa/rsa_ossl.c) applies base
 * blinding, uses CRT (the JWK carries p, q, dp, dq, qi) with
 * BN_mod_exp_mont_consttime, and checks the CRT result itself: if r^e != m it
 * discards the CRT output and recomputes with a constant-time m^d mod n.
 * blindrsa-ts's own BlindSign does a variable-time sjcl exponentiation with d,
 * without blinding, so this path is also the safer one.
 */
export class NativeBlindSigner {
  private readonly sk: KeyObject;
  private readonly pk: KeyObject;
  private readonly modulusBytes: number;

  constructor(privateJwk: JsonWebKey) {
    this.sk = createPrivateKey({ key: privateJwk as import("node:crypto").JsonWebKey, format: "jwk" });
    this.pk = createPublicKey(this.sk);
    this.modulusBytes = Math.ceil((this.sk.asymmetricKeyDetails!.modulusLength ?? 2048) / 8);
  }

  sign(blindedMsgB64: string): string {
    const m = fromBase64(blindedMsgB64);
    if (m.length !== this.modulusBytes) throw new Error("blinded message has wrong length");
    // OpenSSL rejects m >= n for us ("data too large for modulus").
    const s = privateDecrypt({ key: this.sk, padding: constants.RSA_NO_PADDING }, m);
    const check = publicEncrypt({ key: this.pk, padding: constants.RSA_NO_PADDING }, s);
    if (!Buffer.from(m).equals(check)) throw new Error("signing failure");
    return toBase64(new Uint8Array(s));
  }
}
