import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Voucher } from "@hexera/core";
import type { VoucherStore } from "./store";

/** JSON-file voucher store for Node agents and scripts (mode 0600). */
export class FileStore implements VoucherStore {
  constructor(private file: string) {}
  private read(): Voucher[] {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Voucher[]) : [];
  }
  private write(vs: Voucher[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(vs), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  async all() {
    return this.read();
  }
  async add(vs: Voucher[]) {
    const m = new Map(this.read().map((v) => [v.serial, v]));
    for (const v of vs) m.set(v.serial, v);
    this.write([...m.values()]);
  }
  async remove(serials: string[]) {
    const drop = new Set(serials);
    this.write(this.read().filter((v) => !drop.has(v.serial)));
  }
}
