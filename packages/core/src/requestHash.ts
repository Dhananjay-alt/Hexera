import { sha256Hex } from "./bytes";

/**
 * Binds a voucher set to one HTTP request so it can't be lifted onto another.
 * requestHash = sha256( METHOD " " path?query "\n" sha256(body) )
 *
 * Uses path+query rather than the absolute URL so it survives reverse proxies
 * and Host rewriting; merchants serve one origin anyway.
 */
export async function computeRequestHash(method: string, pathWithQuery: string, body: string | Uint8Array = ""): Promise<string> {
  const bodyHash = await sha256Hex(body);
  return sha256Hex(`${method.toUpperCase()} ${pathWithQuery}\n${bodyHash}`);
}

export function pathOf(url: string): string {
  const u = new URL(url, "http://x");
  return u.pathname + u.search;
}
