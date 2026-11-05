export interface Voucher {
  epoch: number;
  /** hex, 64 bytes (see blind.ts) */
  serial: string;
  /** base64 RSA signature */
  sig: string;
}

const SERIAL_RE = /^[0-9a-f]{128}$/;
const B64_RE = /^[A-Za-z0-9+/]+=*$/;

export function isVoucher(v: unknown): v is Voucher {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    Number.isInteger(o.epoch) &&
    (o.epoch as number) >= 0 &&
    typeof o.serial === "string" &&
    SERIAL_RE.test(o.serial) &&
    typeof o.sig === "string" &&
    o.sig.length > 0 &&
    o.sig.length < 1024 &&
    B64_RE.test(o.sig)
  );
}

export function parseVouchers(v: unknown, max = 1000): Voucher[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) throw new Error("vouchers must be a non-empty array");
  for (const x of v) if (!isVoucher(x)) throw new Error("malformed voucher");
  const serials = new Set(v.map((x: Voucher) => x.serial));
  if (serials.size !== v.length) throw new Error("duplicate serial in payload");
  return v as Voucher[];
}

import { fromHex, sha256Hex } from "./bytes";

/** Public id of a spent voucher, as written to hexera-spent. */
export function spendId(serialHex: string): Promise<string> {
  return sha256Hex(fromHex(serialHex));
}
