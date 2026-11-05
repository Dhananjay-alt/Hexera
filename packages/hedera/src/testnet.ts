import {
  AccountId,
  Client,
  PrivateKey,
  TokenId,
  TopicMessageSubmitTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { MirrorClient } from "./mirror";
import type { HederaBackend, SubmitResult, TokenTransfer } from "./types";

export interface TestnetConfig {
  network: "testnet" | "mainnet";
  operatorId: string;
  operatorKey: string;
  /** Keys that sign treasury debits. With a 2-of-3 KeyList, pass two of them. */
  treasuryKeys: string[];
  mirrorUrl?: string;
}

export function parsePrivateKey(k: string): PrivateKey {
  const s = k.trim().replace(/^0x/, "");
  // DER-encoded keys start with 302e (ED25519) / 3030 (ECDSA); raw hex is ambiguous, prefer ECDSA as the portal does.
  if (s.startsWith("30")) return PrivateKey.fromStringDer(s);
  try {
    return PrivateKey.fromStringECDSA(s);
  } catch {
    return PrivateKey.fromStringED25519(s);
  }
}

export class TestnetBackend implements HederaBackend {
  readonly mode = "testnet" as const;
  readonly network;
  readonly mirror: MirrorClient;
  private client: Client;
  private treasuryKeys: PrivateKey[];

  constructor(cfg: TestnetConfig) {
    this.network = `hedera:${cfg.network}` as const;
    this.client = cfg.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
    this.client.setOperator(AccountId.fromString(cfg.operatorId), parsePrivateKey(cfg.operatorKey));
    this.treasuryKeys = cfg.treasuryKeys.map(parsePrivateKey);
    this.mirror = new MirrorClient(cfg.mirrorUrl ?? `https://${cfg.network}.mirrornode.hedera.com`);
  }

  async submitTopicMessage(topicId: string, message: string): Promise<SubmitResult> {
    const tx = await new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(message).execute(this.client);
    const record = await tx.getRecord(this.client);
    const ts = record.consensusTimestamp;
    return {
      transactionId: tx.transactionId.toString(),
      sequenceNumber: Number(record.receipt.topicSequenceNumber?.toString() ?? 0),
      consensusTimestamp: `${ts.seconds.toString()}.${String(ts.nanos.toNumber()).padStart(9, "0")}`,
    };
  }

  async transferToken(tokenId: string, from: string, credits: TokenTransfer[], memo: string) {
    const token = TokenId.fromString(tokenId);
    const total = credits.reduce((a, c) => a + c.amount, 0n);
    let tx = new TransferTransaction().setTransactionMemo(memo.slice(0, 100)).addTokenTransfer(token, from, -Number(total));
    for (const c of credits) tx = tx.addTokenTransfer(token, c.account, Number(c.amount));
    const frozen = tx.freezeWith(this.client);
    for (const k of this.treasuryKeys) await frozen.sign(k);
    const resp = await frozen.execute(this.client);
    await resp.getReceipt(this.client);
    return { transactionId: resp.transactionId.toString() };
  }

  async close() {
    this.client.close();
  }
}
