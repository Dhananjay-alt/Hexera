/**
 * LocalLedger: an in-process stand-in for HCS + HTS + the mirror node, so
 * Hexera can be developed and demoed without testnet keys. It keeps the same
 * data shapes as the real mirror node (transaction ids, consensus timestamps,
 * base64 topic messages, token_transfers), and the facilitator serves it on
 * the real mirror node paths, so the client and audit page don't know the
 * difference. State is persisted to a JSON file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MirrorClient, toMirrorTxId, type MirrorTopicMessage, type MirrorTransaction } from "./mirror";
import type { HederaBackend, SubmitResult, TokenTransfer } from "./types";

interface State {
  nextNum: number;
  lastTs: string; // last consensus ts, nanos as string
  topics: Record<string, { memo: string; messages: MirrorTopicMessage[] }>;
  transactions: Record<string, MirrorTransaction>;
  balances: Record<string, Record<string, string>>; // account -> token -> amount
  names: Record<string, string>; // name -> entity id
}

const EMPTY: State = { nextNum: 1001, lastTs: "0", topics: {}, transactions: {}, balances: {}, names: {} };

export const LOCAL_PAYER = "0.0.2"; // pays local fees

export class LocalLedger implements HederaBackend {
  readonly mode = "local" as const;
  readonly network = "hedera:local" as const;
  readonly mirror: MirrorClient;
  private s: State;

  constructor(private file?: string) {
    this.s = file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as State) : structuredClone(EMPTY);
    this.mirror = new LocalMirror(this);
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.s, null, 1));
  }

  /** Strictly increasing consensus timestamp "seconds.nanos". */
  private nextTimestamp(): string {
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    const last = BigInt(this.s.lastTs);
    const ns = nowNs > last ? nowNs : last + 1n;
    this.s.lastTs = ns.toString();
    return `${ns / 1_000_000_000n}.${(ns % 1_000_000_000n).toString().padStart(9, "0")}`;
  }

  private newTxId(payer: string, ts: string): string {
    return `${payer}@${ts}`;
  }

  /** Get-or-create an entity id by name (topics, accounts, tokens). */
  entity(name: string): string {
    if (!this.s.names[name]) {
      this.s.names[name] = `0.0.${this.s.nextNum++}`;
      this.save();
    }
    return this.s.names[name];
  }

  ensureTopic(name: string, memo = name): string {
    const id = this.entity(`topic:${name}`);
    if (!this.s.topics[id]) {
      this.s.topics[id] = { memo, messages: [] };
      this.save();
    }
    return id;
  }

  balance(account: string, tokenId: string): bigint {
    return BigInt(this.s.balances[account]?.[tokenId] ?? "0");
  }

  private addBalance(account: string, tokenId: string, delta: bigint) {
    const cur = this.balance(account, tokenId);
    if (cur + delta < 0n) throw new Error(`INSUFFICIENT_TOKEN_BALANCE for ${account}`);
    (this.s.balances[account] ??= {})[tokenId] = (cur + delta).toString();
  }

  private recordTx(name: string, payer: string, memo: string, transfers: { token_id: string; account: string; amount: number }[]) {
    const ts = this.nextTimestamp();
    const transactionId = this.newTxId(payer, ts);
    const tx: MirrorTransaction = {
      transaction_id: toMirrorTxId(transactionId),
      consensus_timestamp: ts,
      result: "SUCCESS",
      name,
      memo_base64: btoa(memo),
      token_transfers: transfers,
    };
    this.s.transactions[tx.transaction_id] = tx;
    return { transactionId, ts };
  }

  /** Test faucet: mint tokens to an account (stands in for testnet USDC). */
  mint(tokenId: string, account: string, amount: bigint) {
    this.addBalance(account, tokenId, amount);
    const r = this.recordTx("TOKENMINT", LOCAL_PAYER, "local faucet", [{ token_id: tokenId, account, amount: Number(amount) }]);
    this.save();
    return r.transactionId;
  }

  /** A user-signed HTS transfer (local stand-in for the wallet signing a TransferTransaction). */
  userTransfer(tokenId: string, from: string, to: string, amount: bigint, memo = ""): string {
    if (amount <= 0n) throw new Error("amount must be positive");
    this.addBalance(from, tokenId, -amount);
    this.addBalance(to, tokenId, amount);
    const r = this.recordTx("CRYPTOTRANSFER", from, memo, [
      { token_id: tokenId, account: from, amount: -Number(amount) },
      { token_id: tokenId, account: to, amount: Number(amount) },
    ]);
    this.save();
    return r.transactionId;
  }

  async submitTopicMessage(topicId: string, message: string): Promise<SubmitResult> {
    const topic = this.s.topics[topicId];
    if (!topic) throw new Error(`INVALID_TOPIC_ID ${topicId}`);
    const { transactionId, ts } = this.recordTx("CONSENSUSSUBMITMESSAGE", LOCAL_PAYER, "", []);
    const seq = topic.messages.length + 1;
    const bytes = new TextEncoder().encode(message);
    if (bytes.length > 1024) throw new Error("MESSAGE_SIZE_TOO_LARGE");
    topic.messages.push({
      consensus_timestamp: ts,
      message: btoa(String.fromCharCode(...bytes)),
      sequence_number: seq,
      topic_id: topicId,
      payer_account_id: LOCAL_PAYER,
    });
    this.save();
    return { transactionId, sequenceNumber: seq, consensusTimestamp: ts };
  }

  async transferToken(tokenId: string, from: string, credits: TokenTransfer[], memo: string) {
    const total = credits.reduce((a, c) => a + c.amount, 0n);
    this.addBalance(from, tokenId, -total);
    for (const c of credits) this.addBalance(c.account, tokenId, c.amount);
    const r = this.recordTx("CRYPTOTRANSFER", from, memo, [
      { token_id: tokenId, account: from, amount: -Number(total) },
      ...credits.map((c) => ({ token_id: tokenId, account: c.account, amount: Number(c.amount) })),
    ]);
    this.save();
    return { transactionId: r.transactionId };
  }

  // ---- mirror-node shaped reads ----
  topicMessages(topicId: string, afterSeq = 0, limit = 100) {
    return (this.s.topics[topicId]?.messages ?? []).filter((m) => m.sequence_number > afterSeq).slice(0, limit);
  }
  hasTopic(topicId: string) {
    return !!this.s.topics[topicId];
  }
  transaction(mirrorTxId: string) {
    return this.s.transactions[toMirrorTxId(mirrorTxId)] ?? null;
  }
  tokenBalances(account: string) {
    return Object.entries(this.s.balances[account] ?? {}).map(([token_id, balance]) => ({ token_id, balance: Number(balance) }));
  }

  async close() {
    this.save();
  }
}

class LocalMirror extends MirrorClient {
  constructor(private ledger: LocalLedger) {
    super("local://");
  }
  override async getTopicMessages(topicId: string, afterSequence = 0) {
    return this.ledger.topicMessages(topicId, afterSequence, Number.MAX_SAFE_INTEGER);
  }
  override async getTransaction(txId: string) {
    return this.ledger.transaction(txId);
  }
}
