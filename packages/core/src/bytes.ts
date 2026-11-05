// Platform-neutral byte helpers (Node >= 18 and browsers).

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

/** base64(JSON) as used by x402 v2 headers. Unicode-safe. */
export function encodeJsonB64(value: unknown): string {
  return toBase64(utf8(JSON.stringify(value)));
}

export function decodeJsonB64<T = unknown>(b64: string): T {
  return JSON.parse(new TextDecoder().decode(fromBase64(b64))) as T;
}
