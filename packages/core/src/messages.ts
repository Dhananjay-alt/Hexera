/** Messages published to the two public HCS topics. */

/** hexera-spent: one message per payment. */
export interface SpentMessage {
  t: "spent";
  v: 1;
  epoch: number;
  /**
   * Spend ids: sha256(serial) for each burned voucher. Publishing the hash
   * keeps messages under the 1 KiB HCS limit (about 12 per message) and is
   * enough for anyone to detect a double spend.
   */
  spentIds: string[];
  requestHash: string;
  /** merchant id; lets merchants reconcile serials against payout batches */
  merchant: string;
  units: number;
}

export interface EpochKeyMessage {
  t: "epoch_key";
  v: 1;
  epoch: number;
  publicKey: string; // spki base64
  fingerprint: string;
  validFrom: string; // ISO
  validTo: string; // ISO, spend deadline incl. grace
  suite: string;
}

export interface DepositMessage {
  t: "deposit";
  v: 1;
  depositTx: string;
  amountBase: string;
  unitsCredited: number;
}

export interface IssuedMessage {
  t: "issued";
  v: 1;
  epoch: number;
  units: number;
  /** "deposit" for fresh vouchers, "exchange" for epoch roll-over */
  reason: "deposit" | "exchange";
}

export interface PayoutMessage {
  t: "payout";
  v: 1;
  batchId: string;
  transactionId: string;
  merchants: { merchant: string; account: string; units: number; amountBase: string }[];
  totalUnits: number;
}

export type LedgerMessage = EpochKeyMessage | DepositMessage | IssuedMessage | PayoutMessage;
