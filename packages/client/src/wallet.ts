import {
  HEADERS,
  SCHEME,
  X402_VERSION,
  blindNewVoucher,
  computeRequestHash,
  decodeHeader,
  encodeHeader,
  finalizeVoucher,
  importPublicKey,
  keyFingerprint,
  pathOf,
  verifyVoucherSig,
  type EpochKeyMessage,
  type HexeraPaymentPayload,
  type HexeraRequirements,
  type HexeraSettleResponse,
  type PaymentRequired,
  type Voucher,
} from "@hexera/core";
import { MirrorClient, decodeMessage } from "@hexera/hedera/mirror";
import type { VoucherStore } from "./store";

export interface SupportedInfo {
  mode: "local" | "testnet";
  network: string;
  facilitator: string;
  asset: string;
  treasury: string;
  topics: { spent: string; ledger: string };
  mirrorUrl: string;
  unitValueBase: string;
  unitPriceBase: string;
  currentEpoch: number;
  keys: { epoch: number; publicKey: string; fingerprint: string; validFrom: string; validTo: string }[];
  limits: { freeDailyLimitBase: string; humanDailyCapBase: string; maxIssuePerCall: number };
  worldId: { mode: "dev" | "production"; appId: string | null; rpId: string | null; action: string };
}

export type WorldIdProof = { mode: "dev"; human: string; signal?: string } | { mode?: "idkit"; result: Record<string, unknown>; signal?: string };

export interface WalletOptions {
  facilitatorUrl: string;
  store: VoucherStore;
  /**
   * Mirror node used to check that epoch keys were really published on
   * hexera-ledger. Set this yourself in production; defaulting to the URL the
   * facilitator advertises only protects against a facilitator that forgets
   * to publish, not one that lies about the mirror.
   */
  mirrorUrl?: string;
  /** Refuse keys not found on HCS (default true). */
  requireKeysOnHcs?: boolean;
  /** Random delay before each spend, to blur deposit→spend timing. [minMs, maxMs] */
  spendDelayMs?: [number, number];
  /** Issue batch size; blinding is CPU-bound in the browser. */
  issueBatch?: number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

export class HexeraError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface PaidFetchResult {
  response: Response;
  settlement?: HexeraSettleResponse;
  unitsPaid: number;
}

/**
 * Client wallet for hexera-ecash. Holds vouchers locally, buys them blind
 * from the facilitator, and pays 402 responses automatically.
 */
export class HexeraWallet {
  private supportedCache: { at: number; v: SupportedInfo } | null = null;
  private trustedKeys = new Map<number, CryptoKey>();
  private reserved = new Set<string>();
  private readonly f: typeof fetch;
  private readonly log: (m: string) => void;

  constructor(readonly opts: WalletOptions) {
    this.opts = { requireKeysOnHcs: true, issueBatch: 100, ...opts, facilitatorUrl: opts.facilitatorUrl.replace(/\/$/, "") };
    this.f = opts.fetch ?? ((...a) => fetch(...a));
    this.log = opts.log ?? (() => {});
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.opts.facilitatorUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
    if (!res.ok) throw new HexeraError(json.error ?? "facilitator_error", json.message ?? `facilitator ${path} -> ${res.status}`, res.status);
    return json;
  }

  async supported(force = false): Promise<SupportedInfo> {
    if (!force && this.supportedCache && Date.now() - this.supportedCache.at < 60_000) return this.supportedCache.v;
    const s = await this.call<{ hexera: SupportedInfo }>("/supported");
    this.supportedCache = { at: Date.now(), v: s.hexera };
    return s.hexera;
  }

  /**
   * Epoch public key, but only if it matches an epoch_key message on the
   * public hexera-ledger topic. A facilitator that hands one user a private
   * key (to tag their vouchers) gets caught here.
   */
  async epochKey(epoch: number): Promise<CryptoKey> {
    const hit = this.trustedKeys.get(epoch);
    if (hit) return hit;
    const s = await this.supported();
    const k = s.keys.find((x) => x.epoch === epoch);
    if (!k) throw new HexeraError("unknown_epoch", `facilitator has no key for epoch ${epoch}`);
    if ((await keyFingerprint(k.publicKey)) !== k.fingerprint) throw new HexeraError("bad_key", "key fingerprint mismatch");
    if (this.opts.requireKeysOnHcs) {
      const mirror = new MirrorClient(this.opts.mirrorUrl ?? s.mirrorUrl);
      let found = false;
      for (let i = 0; i < 6 && !found; i++) {
        const msgs = await mirror.getTopicMessages(s.topics.ledger);
        found = msgs.some((m) => {
          const d = decodeMessage<EpochKeyMessage>(m);
          return d?.t === "epoch_key" && d.epoch === epoch && d.publicKey === k.publicKey;
        });
        if (!found && s.mode !== "local") await new Promise((r) => setTimeout(r, 2500)); // mirror lag
      }
      if (!found) throw new HexeraError("key_not_on_hcs", `epoch ${epoch} key is not published on hexera-ledger; refusing it`);
    }
    const key = await importPublicKey(k.publicKey);
    this.trustedKeys.set(epoch, key);
    return key;
  }

  // ---------------------------------------------------------------- balance

  async vouchers(): Promise<Voucher[]> {
    const s = await this.supported();
    const spendable = new Set(s.keys.map((k) => k.epoch));
    return (await this.opts.store.all()).filter((v) => spendable.has(v.epoch));
  }

  async balance(): Promise<{ units: number; reserved: number; usdc: string }> {
    const s = await this.supported();
    const n = (await this.vouchers()).length;
    const base = BigInt(n) * BigInt(s.unitValueBase);
    return { units: n, reserved: this.reserved.size, usdc: (Number(base) / 1e6).toFixed(3) };
  }

  // ---------------------------------------------------------------- deposit

  depositCheck(account: string, amountBase: bigint | string, worldId?: WorldIdProof) {
    return this.call<{ ok: boolean; needsWorldId: boolean; reason?: string; remainingBase?: string }>("/deposit/check", {
      account,
      amountBase: amountBase.toString(),
      worldId,
    });
  }

  /** Turn an on-chain deposit into vouchers. */
  async redeemDeposit(txId: string, worldId?: WorldIdProof, onProgress?: (done: number, total: number) => void) {
    // Check the epoch key is on HCS *before* turning the deposit into a credit,
    // so a refused key can't strand the deposit.
    await this.epochKey((await this.supported(true)).currentEpoch);
    const credit = await this.call<{ credit: string; units: number; amountBase: string }>("/deposit/verify", { txId, worldId });
    this.log(`deposit credited: ${credit.units} units`);
    const bought = await this.buy(credit.credit, credit.units, onProgress);
    return { ...credit, bought };
  }

  /** Blind n fresh serials, get them signed, unblind, verify and store. */
  async buy(credit: string, n: number, onProgress?: (done: number, total: number) => void): Promise<number> {
    const s = await this.supported(true);
    const key = await this.epochKey(s.currentEpoch);
    let done = 0;
    while (done < n) {
      const batch = Math.min(this.opts.issueBatch!, s.limits.maxIssuePerCall, n - done);
      const blinded = await Promise.all(Array.from({ length: batch }, () => blindNewVoucher(key)));
      const r = await this.call<{ epoch: number; blindSigs: string[] }>("/issue", { credit, blinded: blinded.map((b) => b.blindedMsg) });
      if (r.epoch !== s.currentEpoch) throw new HexeraError("epoch_changed", "epoch rolled over during issuance; retry");
      const vouchers: Voucher[] = [];
      for (let i = 0; i < batch; i++) {
        const sig = await finalizeVoucher(key, blinded[i], r.blindSigs[i]); // throws on a bad signature
        vouchers.push({ epoch: r.epoch, serial: blinded[i].serial, sig });
      }
      await this.opts.store.add(vouchers);
      done += batch;
      onProgress?.(done, n);
    }
    return done;
  }

  /** Roll vouchers from older epochs into the current one (no value leaves the system). */
  async exchangeOld(): Promise<number> {
    const s = await this.supported(true);
    const old = (await this.vouchers()).filter((v) => v.epoch < s.currentEpoch && !this.reserved.has(v.serial));
    if (!old.length) return 0;
    const key = await this.epochKey(s.currentEpoch);
    const blinded = await Promise.all(old.map(() => blindNewVoucher(key)));
    const r = await this.call<{ epoch: number; blindSigs: string[] }>("/exchange", { vouchers: old, blinded: blinded.map((b) => b.blindedMsg) });
    const fresh: Voucher[] = [];
    for (let i = 0; i < old.length; i++) fresh.push({ epoch: r.epoch, serial: blinded[i].serial, sig: await finalizeVoucher(key, blinded[i], r.blindSigs[i]) });
    await this.opts.store.add(fresh);
    await this.opts.store.remove(old.map((v) => v.serial));
    return fresh.length;
  }

  // -------------------------------------------------------------------- pay

  private async reserve(units: number): Promise<Voucher[]> {
    // Spend the oldest epoch first so fewer vouchers need exchanging.
    const all = (await this.vouchers()).filter((v) => !this.reserved.has(v.serial)).sort((a, b) => a.epoch - b.epoch);
    if (all.length < units) throw new HexeraError("insufficient_vouchers", `need ${units} vouchers, have ${all.length}`);
    const picked = all.slice(0, units);
    for (const v of picked) this.reserved.add(v.serial);
    // Self-check before spending: never send a voucher that won't verify.
    for (const v of picked) {
      if (!(await verifyVoucherSig(await this.epochKey(v.epoch), v.serial, v.sig))) {
        for (const p of picked) this.reserved.delete(p.serial);
        await this.opts.store.remove([v.serial]);
        throw new HexeraError("corrupt_voucher", "dropped a voucher that failed verification; retry");
      }
    }
    return picked;
  }

  private release(vs: Voucher[]) {
    for (const v of vs) this.reserved.delete(v.serial);
  }

  private async delay() {
    const d = this.opts.spendDelayMs;
    if (!d) return;
    const ms = d[0] + Math.random() * (d[1] - d[0]);
    await new Promise((r) => setTimeout(r, ms));
  }

  /**
   * fetch() that pays x402 hexera-ecash challenges automatically.
   * `maxUnits` is a per-request spending limit.
   */
  async fetch(url: string, init: RequestInit = {}, maxUnits = 50): Promise<PaidFetchResult> {
    const first = await this.f(url, init);
    if (first.status !== 402) return { response: first, unitsPaid: 0 };

    const pr = await readPaymentRequired(first);
    const req = pr?.accepts.find((a): a is HexeraRequirements => a.scheme === SCHEME);
    if (!req) return { response: first, unitsPaid: 0 };
    const units = Number(req.amount);
    if (!Number.isInteger(units) || units < 1) throw new HexeraError("bad_price", `invalid price ${req.amount}`);
    if (units > maxUnits) throw new HexeraError("over_limit", `price ${units} units exceeds limit ${maxUnits}`);

    const s = await this.supported();
    if (req.network !== s.network || req.asset !== s.asset) throw new HexeraError("wrong_facilitator", "402 names a different network/asset than our facilitator");

    const body = init.body;
    if (body != null && typeof body !== "string" && !(body instanceof Uint8Array)) throw new HexeraError("unsupported_body", "paid requests need a string or Uint8Array body");
    const method = (init.method ?? "GET").toUpperCase();
    const requestHash = await computeRequestHash(method, pathOf(url), (body as string | Uint8Array | null) ?? "");

    await this.delay();
    const vouchers = await this.reserve(units);
    const payload: HexeraPaymentPayload = {
      x402Version: X402_VERSION,
      resource: pr!.resource,
      accepted: req,
      payload: { vouchers, requestHash },
    };
    const headers = new Headers(init.headers);
    headers.set(HEADERS.signature, encodeHeader(payload));

    let paid: Response;
    try {
      paid = await this.f(url, { ...init, headers });
    } catch (e) {
      // Unknown outcome: keep them reserved for this session; they may have been burned.
      throw e;
    }
    const respHeader = paid.headers.get(HEADERS.response);
    if (paid.ok && respHeader) {
      await this.opts.store.remove(vouchers.map((v) => v.serial));
      this.release(vouchers);
      const settlement = decodeHeader<HexeraSettleResponse>(respHeader);
      this.log(`paid ${units} unit(s) for ${method} ${url} (hcs ${settlement.transaction})`);
      return { response: paid, settlement, unitsPaid: units };
    }
    const retry = paid.status === 402 ? await readPaymentRequired(paid.clone()) : null;
    if (retry?.error === "voucher_already_spent") {
      await this.opts.store.remove(vouchers.map((v) => v.serial));
    }
    this.release(vouchers);
    if (paid.status === 402) throw new HexeraError("payment_rejected", retry?.error ?? "payment rejected", 402);
    return { response: paid, unitsPaid: 0 };
  }
}

async function readPaymentRequired(res: Response): Promise<PaymentRequired | null> {
  const h = res.headers.get(HEADERS.required);
  if (h) {
    try {
      return decodeHeader<PaymentRequired>(h);
    } catch {
      /* fall through */
    }
  }
  try {
    return (await res.json()) as PaymentRequired;
  } catch {
    return null;
  }
}
