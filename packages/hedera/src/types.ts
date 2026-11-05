import type { HederaNetwork } from "@hexera/core";
import type { MirrorClient } from "./mirror";

export interface SubmitResult {
  transactionId: string;
  sequenceNumber: number;
  /** "seconds.nanos" */
  consensusTimestamp: string;
}

export interface TokenTransfer {
  account: string;
  amount: bigint;
}

/**
 * Everything the facilitator needs from Hedera. Implemented by the real
 * testnet backend and by LocalLedger for offline development.
 */
export interface HederaBackend {
  readonly mode: "testnet" | "local";
  readonly network: HederaNetwork;
  readonly mirror: MirrorClient;
  submitTopicMessage(topicId: string, message: string): Promise<SubmitResult>;
  /** Debit `from` (the threshold-key treasury) and credit each recipient. */
  transferToken(tokenId: string, from: string, credits: TokenTransfer[], memo: string): Promise<{ transactionId: string }>;
  close(): Promise<void>;
}
