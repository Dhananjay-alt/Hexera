import type { Voucher } from "@hexera/core";

/** Where voucher secrets live. They never leave the user's device. */
export interface VoucherStore {
  all(): Promise<Voucher[]>;
  add(vouchers: Voucher[]): Promise<void>;
  remove(serials: string[]): Promise<void>;
}

export class MemoryStore implements VoucherStore {
  private m = new Map<string, Voucher>();
  async all() {
    return [...this.m.values()];
  }
  async add(vs: Voucher[]) {
    for (const v of vs) this.m.set(v.serial, v);
  }
  async remove(serials: string[]) {
    for (const s of serials) this.m.delete(s);
  }
}

/** Browser store (IndexedDB). */
export class IndexedDBStore implements VoucherStore {
  private dbp: Promise<IDBDatabase>;
  constructor(name = "hexera-wallet") {
    this.dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("vouchers", { keyPath: "serial" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.dbp;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("vouchers", mode);
      const req = fn(tx.objectStore("vouchers"));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  }
  async all() {
    return ((await this.run("readonly", (s) => s.getAll())) ?? []) as Voucher[];
  }
  async add(vs: Voucher[]) {
    await this.run("readwrite", (s) => {
      for (const v of vs) s.put(v);
    });
  }
  async remove(serials: string[]) {
    await this.run("readwrite", (s) => {
      for (const k of serials) s.delete(k);
    });
  }
}
