"use client";
import { HexeraWallet, IndexedDBStore, MemoryStore } from "@hexera/client";

export const FACILITATOR_URL = process.env.NEXT_PUBLIC_FACILITATOR_URL!;
export const PUBLISHERS = process.env.NEXT_PUBLIC_PUBLISHERS!.split(",").map((s) => s.trim()).filter(Boolean);
export const AUDIT_URL = process.env.NEXT_PUBLIC_AUDIT_URL!;

const wallets = new Map<string, HexeraWallet>();

/** One voucher wallet per demo account, stored in this browser's IndexedDB. */
export function getWallet(user: string): HexeraWallet {
  let w = wallets.get(user);
  if (!w) {
    const store = typeof indexedDB !== "undefined" ? new IndexedDBStore(`hexera-wallet-${user}`) : new MemoryStore();
    w = new HexeraWallet({ facilitatorUrl: FACILITATOR_URL, store, spendDelayMs: [50, 400] });
    wallets.set(user, w);
  }
  return w;
}
