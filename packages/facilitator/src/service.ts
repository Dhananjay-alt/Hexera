import { join } from "node:path";
import {
  BLIND_SUITE_NAME,
  SCHEME,
  UNIT_PRICE_BASE,
  UNIT_VALUE_BASE,
  X402_VERSION,
  formatUsdc,
  parseVouchers,
  sha256Hex,
  spendId,
  toHex,
  randomBytes,
  verifyVoucherSig,
  type DepositMessage,
  type EpochKeyMessage,
  type HexeraPaymentPayload,
  type HexeraRequirements,
  type HexeraSettleResponse,
  type IssuedMessage,
  type LedgerMessage,
  type PayoutMessage,
  type SpentMessage,
  type VerifyResponse,
  type Voucher,
} from "@hexera/core";
import { LocalLedger, TestnetBackend, decodeMessage, type HederaBackend } from "@hexera/hedera";
import type { FacilitatorConfig } from "./config";
import { Db } from "./db";
import { HttpError, bad } from "./errors";
import { EpochKeys, type EpochKey } from "./keys";
import { verifyWorldId, WorldIdError, type WorldIdInput } from "./worldid";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`[facilitator] ${m}`),
  warn: (m) => console.warn(`[facilitator] ${m}`),
  error: (m) => console.error(`[facilitator] ${m}`),
};

interface Ids {
  treasury: string;
  token: string;
  spentTopic: string;
  ledgerTopic: string;
}

/** HCS messages are capped at 1 KiB; 12 spend ids (64 hex) fit with room to spare. */
const SPENT_IDS_PER_MESSAGE = 12;
/** Hedera allows 10 token transfer entries per transaction: 1 debit + 9 credits. */
const CREDITS_PER_TRANSFER = 9;
const MAX_UNITS_PER_PAYMENT = 1000;

const today = () => new Date().toISOString().slice(0, 10);

export class Facilitator {
  private payoutRunning = false;
  private publishChain: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly cfg: FacilitatorConfig,
    readonly db: Db,
    readonly keys: EpochKeys,
    readonly backend: HederaBackend,
    readonly ids: Ids,
    readonly log: Logger,
  ) {}

  /** Build a facilitator for the configured mode and bring it to a ready state. */
  static async create(cfg: FacilitatorConfig, log: Logger = consoleLogger, dbFile?: string): Promise<Facilitator> {
    const db = new Db(dbFile ?? join(cfg.dataDir, "facilitator.sqlite"));
    const keys = new EpochKeys(join(cfg.dataDir, "keys"), cfg.epochSeconds, cfg.epochGraceSeconds);
    let backend: HederaBackend;
    let ids: Ids;

    if (cfg.mode === "local") {
      const ledger = new LocalLedger(dbFile === ":memory:" ? undefined : join(cfg.dataDir, "local-ledger.json"));
      backend = ledger;
      ids = {
        treasury: ledger.entity("account:hexera-treasury"),
        token: ledger.entity("token:USDC"),
        spentTopic: ledger.ensureTopic("hexera-spent"),
        ledgerTopic: ledger.ensureTopic("hexera-ledger"),
      };
      for (const m of cfg.merchants) m.account ??= ledger.entity(`account:merchant:${m.id}`);
    } else {
      backend = new TestnetBackend({
        network: cfg.network,
        operatorId: cfg.operatorId!,
        operatorKey: cfg.operatorKey!,
        treasuryKeys: cfg.treasuryKeys,
        mirrorUrl: cfg.mirrorUrl,
      });
      ids = { treasury: cfg.treasuryAccountId!, token: cfg.tokenId!, spentTopic: cfg.spentTopicId!, ledgerTopic: cfg.ledgerTopicId! };
    }

    const f = new Facilitator(cfg, db, keys, backend, ids, log);
    await f.init();
    return f;
  }

  get local(): LocalLedger | null {
    return this.backend instanceof LocalLedger ? this.backend : null;
  }

  private async init() {
    for (const m of this.cfg.merchants) {
      this.db.db
        .prepare("INSERT INTO merchants (id, account, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET account = excluded.account, name = excluded.name")
        .run(m.id, m.account!, m.name);
    }
    await this.syncSpent().catch((e) => this.log.warn(`spent-topic sync failed: ${e.message}`));
    const onHcs = await this.syncLedger().catch((e) => {
      this.log.warn(`ledger-topic sync failed: ${e.message}`);
      return null;
    });
    const key = (await this.keys.current()).key;
    // Trust the public topic, not a local flag: clients refuse keys that aren't on HCS.
    if (onHcs && !onHcs.has(key.publicKeyB64)) this.db.db.prepare("DELETE FROM kv WHERE k = ?").run(`key_published:${key.epoch}`);
    await this.currentKey();
  }

  /**
   * Read hexera-ledger: re-import deposit records (so a lost database can't
   * credit the same deposit twice) and return the epoch keys published there.
   */
  async syncLedger(): Promise<Set<string>> {
    const msgs = await this.backend.mirror.getTopicMessages(this.ids.ledgerTopic, 0);
    const keys = new Set<string>();
    const ins = this.db.db.prepare(
      "INSERT OR IGNORE INTO deposits (tx_id, account, amount_base, day, human, status, credit, created_at) VALUES (?, '', ?, '', NULL, 'credited', NULL, ?)",
    );
    let n = 0;
    for (const m of msgs) {
      const d = decodeMessage<LedgerMessage>(m);
      if (d?.t === "epoch_key") keys.add(d.publicKey);
      if (d?.t === "deposit") n += Number(ins.run(d.depositTx, d.amountBase, Date.now()).changes);
    }
    if (n) this.log.info(`imported ${n} deposit record(s) from hexera-ledger`);
    return keys;
  }

  /**
   * Operator recovery: refund a deposit whose credit was never used (e.g. the
   * client lost it). Paid back to the depositing account in the next payout.
   */
  async refundUnusedDeposit(txId: string) {
    const row = this.db.db.prepare("SELECT status, credit FROM deposits WHERE tx_id = ?").get(txId) as { status: string; credit: string | null } | undefined;
    if (!row) throw new HttpError(404, "unknown_deposit", "deposit not found");
    if (row.status !== "credited") throw new HttpError(409, "not_refundable", `deposit is ${row.status}`);
    if (row.credit) {
      const c = this.db.db.prepare("SELECT units_used FROM credits WHERE token = ?").get(row.credit) as { units_used: number } | undefined;
      if (c && c.units_used > 0) throw new HttpError(409, "credit_used", "vouchers were already issued for this deposit");
    }
    const tx = await this.backend.mirror.getTransaction(txId);
    const from = tx?.token_transfers?.find((t) => t.token_id === this.ids.token && t.amount < 0)?.account;
    if (!from) throw new HttpError(404, "deposit_not_found", "deposit transaction not found on mirror node");
    this.db.tx(() => {
      if (row.credit) this.db.db.prepare("DELETE FROM credits WHERE token = ?").run(row.credit);
      this.db.db.prepare("UPDATE deposits SET status = 'refund_pending', account = ?, credit = NULL WHERE tx_id = ?").run(from, txId);
    });
    this.log.warn(`deposit ${txId} queued for refund to ${from}`);
    return { txId, account: from, status: "refund_pending" };
  }

  // ---------------------------------------------------------------- ledger

  /** Serialised, fire-and-forget publishing to hexera-ledger. */
  private publishLedger(msg: LedgerMessage): Promise<void> {
    const p = this.publishChain.then(async () => {
      try {
        const r = await this.backend.submitTopicMessage(this.ids.ledgerTopic, JSON.stringify(msg));
        this.log.info(`hexera-ledger <- ${msg.t} (seq ${r.sequenceNumber}, tx ${r.transactionId})`);
      } catch (e) {
        this.log.error(`failed to publish ${msg.t} to hexera-ledger: ${(e as Error).message}`);
      }
    });
    this.publishChain = p;
    return p;
  }

  /** Current epoch key, published on HCS the first time it is used. */
  async currentKey(): Promise<EpochKey> {
    const { key } = await this.keys.current();
    const flag = `key_published:${key.epoch}`;
    if (!this.db.get(flag)) {
      this.db.set(flag, "1");
      const msg: EpochKeyMessage = {
        t: "epoch_key",
        v: 1,
        epoch: key.epoch,
        publicKey: key.publicKeyB64,
        fingerprint: key.fingerprint,
        validFrom: key.validFrom.toISOString(),
        validTo: key.validTo.toISOString(),
        suite: BLIND_SUITE_NAME,
      };
      await this.publishLedger(msg);
    }
    return key;
  }

  // ------------------------------------------------------------- supported

  async supported() {
    const key = await this.currentKey();
    const active = await this.keys.active();
    return {
      kinds: [
        {
          x402Version: X402_VERSION,
          scheme: SCHEME,
          network: this.backend.network,
          extra: { epoch: key.epoch, asset: this.ids.token },
        },
      ],
      extensions: [],
      signers: {},
      hexera: {
        mode: this.backend.mode,
        network: this.backend.network,
        facilitator: this.cfg.publicUrl,
        asset: this.ids.token,
        treasury: this.ids.treasury,
        topics: { spent: this.ids.spentTopic, ledger: this.ids.ledgerTopic },
        mirrorUrl: this.backend.mode === "local" ? this.cfg.publicUrl : this.backend.mirror.baseUrl,
        suite: BLIND_SUITE_NAME,
        unitValueBase: UNIT_VALUE_BASE.toString(),
        unitPriceBase: UNIT_PRICE_BASE.toString(),
        currentEpoch: key.epoch,
        keys: active.map((k) => ({
          epoch: k.epoch,
          publicKey: k.publicKeyB64,
          fingerprint: k.fingerprint,
          validFrom: k.validFrom.toISOString(),
          validTo: k.validTo.toISOString(),
        })),
        limits: {
          freeDailyLimitBase: this.cfg.freeDailyLimitBase.toString(),
          humanDailyCapBase: this.cfg.humanDailyCapBase.toString(),
          maxIssuePerCall: this.cfg.maxIssuePerCall,
        },
        worldId: {
          mode: this.cfg.worldIdMode,
          appId: this.cfg.worldAppId ?? null,
          rpId: this.cfg.worldRpId ?? null,
          action: this.cfg.worldAction,
        },
      },
    };
  }

  merchants() {
    return this.db.db.prepare("SELECT id, account, name FROM merchants ORDER BY id").all() as { id: string; account: string; name: string }[];
  }

  // --------------------------------------------------------------- deposit

  private depositedToday(column: "account" | "human", value: string): bigint {
    const rows = this.db.db
      .prepare(`SELECT amount_base FROM deposits WHERE ${column} = ? AND day = ? AND status = 'credited'`)
      .all(value, today()) as { amount_base: string }[];
    return rows.reduce((a, r) => a + BigInt(r.amount_base), 0n);
  }

  /**
   * Pre-flight a deposit before the user sends money: is it within the free
   * per-account limit, or does it need (and pass) the per-human cap?
   */
  async depositCheck(input: { account: string; amountBase: string; worldId?: WorldIdInput }) {
    const amount = BigInt(input.amountBase);
    if (amount <= 0n) throw bad("invalid_amount", "amount must be positive");
    const acct = this.depositedToday("account", input.account);
    const free = acct + amount <= this.cfg.freeDailyLimitBase;
    if (!input.worldId) {
      return free
        ? { ok: true, needsWorldId: false }
        : { ok: false, needsWorldId: true, reason: `deposits above ${formatUsdc(this.cfg.freeDailyLimitBase)} USDC/day need World ID` };
    }
    const { human } = await this.verifyHuman(input.worldId, input.account);
    const used = this.depositedToday("human", human);
    if (used + amount > this.cfg.humanDailyCapBase) {
      return {
        ok: false,
        needsWorldId: false,
        reason: `per-human daily cap reached: ${formatUsdc(used)} of ${formatUsdc(this.cfg.humanDailyCapBase)} USDC used today`,
      };
    }
    return { ok: true, needsWorldId: false, remainingBase: (this.cfg.humanDailyCapBase - used - amount).toString() };
  }

  private async verifyHuman(worldId: WorldIdInput, account: string) {
    try {
      return await verifyWorldId(this.cfg, worldId, account);
    } catch (e) {
      if (e instanceof WorldIdError) throw new HttpError(403, "world_id_invalid", e.message);
      throw e;
    }
  }

  /**
   * Check a USDC deposit on the mirror node and turn it into a one-time
   * credit for K vouchers. The credit is the only link between deposit and
   * issuance, and it ends at /issue: the signatures are blind.
   */
  async depositVerify(input: { txId: string; worldId?: WorldIdInput }) {
    if (!input.txId || typeof input.txId !== "string") throw bad("invalid_tx", "txId required");
    const existing = this.db.db.prepare("SELECT status FROM deposits WHERE tx_id = ?").get(input.txId) as { status: string } | undefined;
    if (existing) throw new HttpError(409, "deposit_already_used", `deposit already ${existing.status}`);

    const tx =
      this.backend.mode === "local"
        ? await this.backend.mirror.getTransaction(input.txId)
        : await this.backend.mirror.waitForTransaction(input.txId);
    if (!tx) throw new HttpError(404, "deposit_not_found", "transaction not found on mirror node");
    if (tx.result !== "SUCCESS") throw bad("deposit_failed", `transaction result ${tx.result}`);

    const transfers = (tx.token_transfers ?? []).filter((t) => t.token_id === this.ids.token);
    const credit = transfers.filter((t) => t.account === this.ids.treasury && t.amount > 0);
    const debits = transfers.filter((t) => t.amount < 0);
    if (credit.length !== 1 || debits.length !== 1) throw bad("not_a_deposit", "expected one USDC transfer from one account to the Hexera treasury");
    const amount = BigInt(credit[0].amount);
    const account = debits[0].account;

    // Spending controls: free limit per account, World ID cap per human.
    let human: string | null = null;
    if (input.worldId) human = (await this.verifyHuman(input.worldId, account)).human;
    const acctToday = this.depositedToday("account", account);
    if (!human && acctToday + amount > this.cfg.freeDailyLimitBase) {
      throw new HttpError(403, "world_id_required", `deposits above ${formatUsdc(this.cfg.freeDailyLimitBase)} USDC/day per account need World ID; retry with a proof`);
    }
    if (human && this.depositedToday("human", human) + amount > this.cfg.humanDailyCapBase) {
      this.db.db
        .prepare("INSERT INTO deposits (tx_id, account, amount_base, day, human, status, created_at) VALUES (?, ?, ?, ?, ?, 'refund_pending', ?)")
        .run(input.txId, account, amount.toString(), today(), human, Date.now());
      this.log.warn(`deposit ${input.txId} refused: per-human cap reached; refund queued for next payout`);
      throw new HttpError(403, "human_cap_exceeded", `per-human daily cap of ${formatUsdc(this.cfg.humanDailyCapBase)} USDC reached; deposit will be refunded`);
    }

    const units = Number(amount / UNIT_PRICE_BASE);
    if (units < 1) throw bad("deposit_too_small", `minimum deposit is ${formatUsdc(UNIT_PRICE_BASE)} USDC`);
    const token = toHex(randomBytes(32));
    this.db.tx(() => {
      this.db.db.prepare("INSERT INTO credits (token, units_total, created_at) VALUES (?, ?, ?)").run(token, units, Date.now());
      this.db.db
        .prepare("INSERT INTO deposits (tx_id, account, amount_base, day, human, status, credit, created_at) VALUES (?, ?, ?, ?, ?, 'credited', ?, ?)")
        .run(input.txId, account, amount.toString(), today(), human, token, Date.now());
    });
    this.log.info(`deposit ${input.txId}: ${account} deposited ${formatUsdc(amount)} USDC -> ${units} voucher credit${human ? " (World ID verified)" : ""}`);
    const msg: DepositMessage = { t: "deposit", v: 1, depositTx: input.txId, amountBase: amount.toString(), unitsCredited: units };
    void this.publishLedger(msg);
    return { credit: token, units, amountBase: amount.toString(), account };
  }

  // ----------------------------------------------------------------- issue

  /** Blind-sign up to the remaining credit. The facilitator never sees serials. */
  async issue(input: { credit: string; blinded: string[] }) {
    const { credit, blinded } = input;
    if (!Array.isArray(blinded) || blinded.length === 0) throw bad("invalid_request", "blinded must be a non-empty array");
    if (blinded.length > this.cfg.maxIssuePerCall) throw bad("too_many", `at most ${this.cfg.maxIssuePerCall} per call`);
    if (blinded.some((b) => typeof b !== "string" || b.length > 1024)) throw bad("invalid_request", "malformed blinded message");

    const n = blinded.length;
    this.db.tx(() => {
      const row = this.db.db.prepare("SELECT units_total, units_used FROM credits WHERE token = ?").get(credit) as
        | { units_total: number; units_used: number }
        | undefined;
      if (!row) throw new HttpError(404, "unknown_credit", "unknown credit");
      if (row.units_used + n > row.units_total) throw new HttpError(402, "credit_exhausted", `credit has ${row.units_total - row.units_used} units left`);
      this.db.db.prepare("UPDATE credits SET units_used = units_used + ? WHERE token = ?").run(n, credit);
    });

    const key = await this.currentKey();
    let sigs: string[];
    try {
      sigs = blinded.map((b) => key.signer.sign(b));
    } catch (e) {
      this.db.db.prepare("UPDATE credits SET units_used = units_used - ? WHERE token = ?").run(n, credit);
      throw bad("invalid_blinded_message", (e as Error).message);
    }
    this.bumpIssued(key.epoch, "deposit", n);
    const left = this.db.db.prepare("SELECT units_total - units_used AS left FROM credits WHERE token = ?").get(credit) as { left: number };
    return { epoch: key.epoch, publicKey: key.publicKeyB64, blindSigs: sigs, creditRemaining: left.left };
  }

  private bumpIssued(epoch: number, reason: "deposit" | "exchange", n: number) {
    const k = `issued_unpublished:${epoch}:${reason}`;
    this.db.set(k, String(Number(this.db.get(k) ?? 0) + n));
    const tk = `issued_total:${epoch}`;
    this.db.set(tk, String(Number(this.db.get(tk) ?? 0) + n));
  }

  // ---------------------------------------------------------- verify/settle

  private async checkPayment(paymentPayload: HexeraPaymentPayload, req: HexeraRequirements) {
    const fail = (invalidReason: string, invalidMessage: string) => ({ ok: false as const, invalidReason, invalidMessage });
    if (!paymentPayload || typeof paymentPayload !== "object" || !req || typeof req !== "object") return fail("invalid_payload", "missing payload or requirements");
    if (paymentPayload.x402Version !== X402_VERSION) return fail("invalid_x402_version", "x402Version must be 2");
    if (req.scheme !== SCHEME || paymentPayload.accepted?.scheme !== SCHEME) return fail("unsupported_scheme", `scheme must be ${SCHEME}`);
    if (req.network !== this.backend.network || paymentPayload.accepted.network !== req.network) return fail("invalid_network", `network must be ${this.backend.network}`);
    const acc = paymentPayload.accepted;
    if (acc.payTo !== req.payTo || acc.amount !== req.amount || acc.asset !== req.asset) return fail("requirements_mismatch", "accepted requirements differ from the server's");
    if (req.asset !== this.ids.token) return fail("invalid_asset", "unsupported asset");
    const merchant = this.db.db.prepare("SELECT id, name FROM merchants WHERE id = ?").get(req.payTo) as { id: string; name: string } | undefined;
    if (!merchant) return fail("unknown_merchant", `merchant ${req.payTo} is not registered`);
    const units = Number(req.amount);
    if (!Number.isInteger(units) || units < 1 || units > MAX_UNITS_PER_PAYMENT) return fail("invalid_amount", "amount must be a whole number of units");

    let vouchers: Voucher[];
    try {
      vouchers = parseVouchers(paymentPayload.payload?.vouchers, MAX_UNITS_PER_PAYMENT);
    } catch (e) {
      return fail("invalid_payload", (e as Error).message);
    }
    if (vouchers.length !== units) return fail("invalid_amount", `expected ${units} vouchers, got ${vouchers.length}`);
    const requestHash = paymentPayload.payload.requestHash;
    if (typeof requestHash !== "string" || !/^[0-9a-f]{64}$/.test(requestHash)) return fail("invalid_payload", "requestHash must be 64 hex chars");

    for (const v of vouchers) {
      if (!this.keys.isSpendable(v.epoch)) return fail("expired_epoch", `epoch ${v.epoch} is not spendable`);
      const key = await this.keys.get(v.epoch);
      if (!key) return fail("unknown_epoch", `no key for epoch ${v.epoch}`);
      if (!(await verifyVoucherSig(key.publicKey, v.serial, v.sig))) return fail("invalid_signature", "voucher signature does not verify");
    }
    const spendIds = await Promise.all(vouchers.map((v) => spendId(v.serial)));
    const seen = this.db.db
      .prepare(`SELECT spend_id FROM spent WHERE spend_id IN (${spendIds.map(() => "?").join(",")})`)
      .all(...spendIds) as { spend_id: string }[];
    if (seen.length) return fail("voucher_already_spent", `${seen.length} voucher(s) already spent on hexera-spent`);
    return { ok: true as const, vouchers, spendIds, merchant, units, requestHash };
  }

  async verify(paymentPayload: HexeraPaymentPayload, req: HexeraRequirements): Promise<VerifyResponse> {
    const r = await this.checkPayment(paymentPayload, req);
    if (!r.ok) return { isValid: false, invalidReason: r.invalidReason, invalidMessage: r.invalidMessage };
    // No `payer`: the facilitator does not know who paid.
    return { isValid: true, extra: { units: r.units } };
  }

  /**
   * Burn vouchers on hexera-spent. The local reservation (a SQLite insert
   * under one transaction) closes races inside this facilitator; HCS
   * consensus order is the public record anyone can audit.
   */
  async settle(paymentPayload: HexeraPaymentPayload, req: HexeraRequirements): Promise<HexeraSettleResponse> {
    const network = this.backend.network;
    const r = await this.checkPayment(paymentPayload, req);
    if (!r.ok) return { success: false, errorReason: r.invalidReason, errorMessage: r.invalidMessage, transaction: "", network };

    const epoch = r.vouchers[0].epoch;
    try {
      this.db.tx(() => {
        const ins = this.db.db.prepare(
          "INSERT INTO spent (spend_id, epoch, merchant, request_hash, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
        );
        for (let i = 0; i < r.spendIds.length; i++) ins.run(r.spendIds[i], r.vouchers[i].epoch, r.merchant.id, r.requestHash, Date.now());
      });
    } catch {
      return { success: false, errorReason: "voucher_already_spent", errorMessage: "lost a double-spend race", transaction: "", network };
    }

    const submissions: { transactionId: string; consensusTimestamp: string; ids: string[] }[] = [];
    try {
      for (let i = 0; i < r.spendIds.length; i += SPENT_IDS_PER_MESSAGE) {
        const ids = r.spendIds.slice(i, i + SPENT_IDS_PER_MESSAGE);
        const msg: SpentMessage = { t: "spent", v: 1, epoch, spentIds: ids, requestHash: r.requestHash, merchant: r.merchant.id, units: ids.length };
        const sub = await this.backend.submitTopicMessage(this.ids.spentTopic, JSON.stringify(msg));
        submissions.push({ ...sub, ids });
      }
    } catch (e) {
      if (submissions.length === 0) {
        const del = this.db.db.prepare("DELETE FROM spent WHERE spend_id = ? AND status = 'pending'");
        for (const id of r.spendIds) del.run(id);
        this.log.error(`settle failed, HCS submit error: ${(e as Error).message}`);
        return { success: false, errorReason: "settlement_failed", errorMessage: "could not write to hexera-spent", transaction: "", network };
      }
      // Partially burned: keep everything reserved (the vouchers are unusable) and still pay the merchant for
      // what was burned, so value is not lost; log loudly.
      this.log.error(`partial HCS submit for ${r.requestHash}: ${(e as Error).message}`);
    }

    const upd = this.db.db.prepare("UPDATE spent SET status = 'final', hcs_tx = ?, consensus_ts = ? WHERE spend_id = ?");
    let burned = 0;
    for (const s of submissions) {
      for (const id of s.ids) upd.run(s.transactionId, s.consensusTimestamp, id);
      burned += s.ids.length;
    }
    this.db.db.prepare("UPDATE merchants SET pending_units = pending_units + ? WHERE id = ?").run(burned, r.merchant.id);

    const first = submissions[0];
    this.log.info(
      `settled ${burned} unit(s) for merchant=${r.merchant.id} request=${r.requestHash.slice(0, 12)}… hcs=${first.transactionId} payer=<unknown: blind-signed vouchers>`,
    );
    if (burned < r.units) {
      return { success: false, errorReason: "settlement_failed", errorMessage: "partially settled", transaction: first.transactionId, network };
    }
    return {
      success: true,
      transaction: first.transactionId,
      network,
      amount: (BigInt(burned) * UNIT_VALUE_BASE).toString(),
      spentIds: r.spendIds,
      consensusTimestamp: first.consensusTimestamp,
      extra: { units: burned, spentTopic: this.ids.spentTopic, transactions: submissions.map((s) => s.transactionId) },
    };
  }

  // -------------------------------------------------------------- exchange

  /**
   * Epoch roll-over: burn vouchers from an old epoch and blind-sign the same
   * number of new ones. Value carries over; no cash-out path exists.
   */
  async exchange(input: { vouchers: Voucher[]; blinded: string[] }) {
    let vouchers: Voucher[];
    try {
      vouchers = parseVouchers(input.vouchers, this.cfg.maxIssuePerCall);
    } catch (e) {
      throw bad("invalid_payload", (e as Error).message);
    }
    if (!Array.isArray(input.blinded) || input.blinded.length !== vouchers.length) throw bad("invalid_request", "need one blinded message per voucher");
    const key = await this.currentKey();
    for (const v of vouchers) {
      if (v.epoch >= key.epoch) throw bad("not_expiring", "only vouchers from earlier epochs can be exchanged");
      const k = await this.keys.get(v.epoch);
      if (!k || !this.keys.isSpendable(v.epoch)) throw bad("expired_epoch", `epoch ${v.epoch} is past its grace period`);
      if (!(await verifyVoucherSig(k.publicKey, v.serial, v.sig))) throw bad("invalid_signature", "voucher signature does not verify");
    }
    // Sign first: if any blinded message is malformed, nothing gets burned.
    let sigs: string[];
    try {
      sigs = input.blinded.map((b) => key.signer.sign(b));
    } catch (e) {
      throw bad("invalid_blinded_message", (e as Error).message);
    }
    const spendIds = await Promise.all(vouchers.map((v) => spendId(v.serial)));
    const requestHash = await sha256Hex(input.blinded.join(","));
    try {
      this.db.tx(() => {
        const ins = this.db.db.prepare("INSERT INTO spent (spend_id, epoch, merchant, request_hash, status, created_at) VALUES (?, ?, 'hexera:exchange', ?, 'final', ?)");
        for (let i = 0; i < spendIds.length; i++) ins.run(spendIds[i], vouchers[i].epoch, requestHash, Date.now());
      });
    } catch {
      throw new HttpError(409, "voucher_already_spent", "voucher already spent");
    }
    for (let i = 0; i < spendIds.length; i += SPENT_IDS_PER_MESSAGE) {
      const ids = spendIds.slice(i, i + SPENT_IDS_PER_MESSAGE);
      const msg: SpentMessage = { t: "spent", v: 1, epoch: vouchers[0].epoch, spentIds: ids, requestHash, merchant: "hexera:exchange", units: ids.length };
      await this.backend.submitTopicMessage(this.ids.spentTopic, JSON.stringify(msg));
    }
    this.bumpIssued(key.epoch, "exchange", sigs.length);
    return { epoch: key.epoch, publicKey: key.publicKeyB64, blindSigs: sigs };
  }

  // ---------------------------------------------------------------- payout

  /** Pay every merchant its pending balance (plus queued refunds) in batched HTS transfers. */
  async payout(): Promise<{ batches: { batchId: string; transactionId: string; merchants: number; totalUnits: number }[] } | null> {
    if (this.payoutRunning) return null;
    this.payoutRunning = true;
    try {
      await this.flushIssued();
      const merchants = this.db.tx(() => {
        const rows = this.db.db.prepare("SELECT id, account, pending_units FROM merchants WHERE pending_units > 0").all() as {
          id: string;
          account: string;
          pending_units: number;
        }[];
        const dec = this.db.db.prepare("UPDATE merchants SET pending_units = pending_units - ? WHERE id = ?");
        for (const m of rows) dec.run(m.pending_units, m.id);
        return rows;
      });
      const refunds = this.db.db.prepare("SELECT tx_id, account, amount_base FROM deposits WHERE status = 'refund_pending'").all() as {
        tx_id: string;
        account: string;
        amount_base: string;
      }[];

      type Credit = { kind: "merchant"; id: string; account: string; units: number } | { kind: "refund"; txId: string; account: string; amount: bigint };
      const credits: Credit[] = [
        ...merchants.map((m) => ({ kind: "merchant" as const, id: m.id, account: m.account, units: m.pending_units })),
        ...refunds.map((r) => ({ kind: "refund" as const, txId: r.tx_id, account: r.account, amount: BigInt(r.amount_base) })),
      ];
      if (credits.length === 0) return { batches: [] };

      const batches = [];
      for (let i = 0; i < credits.length; i += CREDITS_PER_TRANSFER) {
        const chunk = credits.slice(i, i + CREDITS_PER_TRANSFER);
        const batchId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${toHex(randomBytes(3))}`;
        const transfers = chunk.map((c) => ({ account: c.account, amount: c.kind === "merchant" ? BigInt(c.units) * UNIT_VALUE_BASE : c.amount }));
        let transactionId: string;
        try {
          ({ transactionId } = await this.backend.transferToken(this.ids.token, this.ids.treasury, transfers, `hexera payout ${batchId}`));
        } catch (e) {
          // Put the units back so the next run retries.
          for (const c of chunk) if (c.kind === "merchant") this.db.db.prepare("UPDATE merchants SET pending_units = pending_units + ? WHERE id = ?").run(c.units, c.id);
          this.log.error(`payout batch ${batchId} failed: ${(e as Error).message}`);
          continue;
        }
        const ms = chunk.filter((c): c is Extract<Credit, { kind: "merchant" }> => c.kind === "merchant");
        const summary: PayoutMessage = {
          t: "payout",
          v: 1,
          batchId,
          transactionId,
          merchants: ms.map((m) => ({ merchant: m.id, account: m.account, units: m.units, amountBase: (BigInt(m.units) * UNIT_VALUE_BASE).toString() })),
          totalUnits: ms.reduce((a, m) => a + m.units, 0),
        };
        this.db.tx(() => {
          for (const m of ms) this.db.db.prepare("UPDATE merchants SET paid_units = paid_units + ? WHERE id = ?").run(m.units, m.id);
          for (const c of chunk) if (c.kind === "refund") this.db.db.prepare("UPDATE deposits SET status = 'refunded' WHERE tx_id = ?").run(c.txId);
          this.db.db.prepare("INSERT INTO payouts (batch_id, tx_id, summary, created_at) VALUES (?, ?, ?, ?)").run(batchId, transactionId, JSON.stringify(summary), Date.now());
        });
        const nRefunds = chunk.length - ms.length;
        this.log.info(`payout ${batchId}: ${ms.length} merchant(s), ${summary.totalUnits} unit(s)${nRefunds ? `, ${nRefunds} refund(s)` : ""} -> tx ${transactionId}`);
        if (ms.length) await this.publishLedger(summary);
        batches.push({ batchId, transactionId, merchants: ms.length, totalUnits: summary.totalUnits });
      }
      return { batches };
    } finally {
      this.payoutRunning = false;
    }
  }

  /** Publish issued-voucher counts (batched, so issuance timing isn't broadcast per user). */
  private async flushIssued() {
    const rows = this.db.db.prepare("SELECT k, v FROM kv WHERE k LIKE 'issued_unpublished:%' AND v != '0'").all() as { k: string; v: string }[];
    for (const row of rows) {
      const [, epoch, reason] = row.k.split(":");
      const msg: IssuedMessage = { t: "issued", v: 1, epoch: Number(epoch), units: Number(row.v), reason: reason as "deposit" | "exchange" };
      this.db.set(row.k, "0");
      await this.publishLedger(msg);
    }
  }

  // ------------------------------------------------------------------ sync

  /**
   * Rebuild/extend the spent cache from the public HCS topic, so a restarted
   * facilitator (or a second one sharing the topic) never accepts a serial
   * that is already burned.
   */
  async syncSpent() {
    const after = Number(this.db.get("spent_seq") ?? 0);
    const msgs = await this.backend.mirror.getTopicMessages(this.ids.spentTopic, after);
    const ins = this.db.db.prepare(
      "INSERT OR IGNORE INTO spent (spend_id, epoch, merchant, request_hash, consensus_ts, status, created_at) VALUES (?, ?, ?, ?, ?, 'external', ?)",
    );
    let n = 0;
    for (const m of msgs) {
      const d = decodeMessage<SpentMessage>(m);
      if (d?.t === "spent" && Array.isArray(d.spentIds)) for (const id of d.spentIds) n += Number(ins.run(id, d.epoch, d.merchant, d.requestHash, m.consensus_timestamp, Date.now()).changes);
      this.db.set("spent_seq", String(m.sequence_number));
    }
    if (n) this.log.info(`synced ${n} spent id(s) from hexera-spent`);
  }

  // ----------------------------------------------------------------- books

  async books() {
    const q = <T>(sql: string) => this.db.db.prepare(sql).get() as T;
    const dep = this.db.db.prepare("SELECT amount_base FROM deposits WHERE status = 'credited'").all() as { amount_base: string }[];
    const issued = (this.db.db.prepare("SELECT v FROM kv WHERE k LIKE 'issued_total:%'").all() as { v: string }[]).reduce((a, r) => a + Number(r.v), 0);
    const merchants = this.db.db.prepare("SELECT id, name, account, pending_units, paid_units FROM merchants ORDER BY id").all();
    return {
      depositsCredited: dep.length,
      depositedBase: dep.reduce((a, r) => a + BigInt(r.amount_base), 0n).toString(),
      unitsCredited: q<{ n: number | null }>("SELECT SUM(units_total) AS n FROM credits").n ?? 0,
      unitsIssued: issued,
      unitsSpent: q<{ n: number }>("SELECT COUNT(*) AS n FROM spent WHERE status = 'final' AND merchant != 'hexera:exchange'").n,
      refundsPending: q<{ n: number }>("SELECT COUNT(*) AS n FROM deposits WHERE status = 'refund_pending'").n,
      merchants,
      treasuryBalanceBase: this.local ? this.local.balance(this.ids.treasury, this.ids.token).toString() : null,
    };
  }

  async close() {
    await this.publishChain;
    await this.backend.close();
  }
}
