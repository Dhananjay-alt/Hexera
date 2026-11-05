import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Facilitator state. HCS is the source of truth for spent serials; this is a
 * cache plus the private books (deposits, credits, merchant balances).
 */
export class Db {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS deposits (
        tx_id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        amount_base TEXT NOT NULL,
        day TEXT NOT NULL,
        human TEXT,
        status TEXT NOT NULL,            -- credited | refund_pending | refunded
        credit TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deposits_acct_day ON deposits(account, day);
      CREATE INDEX IF NOT EXISTS deposits_human_day ON deposits(human, day);
      CREATE TABLE IF NOT EXISTS credits (
        token TEXT PRIMARY KEY,
        units_total INTEGER NOT NULL,
        units_used INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spent (
        spend_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        merchant TEXT NOT NULL,
        request_hash TEXT,
        hcs_tx TEXT,
        consensus_ts TEXT,
        status TEXT NOT NULL,           -- pending | final | external
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS merchants (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        name TEXT NOT NULL,
        pending_units INTEGER NOT NULL DEFAULT 0,
        paid_units INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS payouts (
        batch_id TEXT PRIMARY KEY,
        tx_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  get(k: string): string | undefined {
    return (this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined)?.v;
  }
  set(k: string, v: string) {
    this.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }
}
