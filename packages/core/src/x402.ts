import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { decodeJsonB64, encodeJsonB64 } from "./bytes";
import { SCHEME, X402_VERSION, type HederaNetwork } from "./constants";
import type { Voucher } from "./voucher";

export type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse, VerifyResponse };

export interface HexeraExtra {
  facilitator: string;
  epoch: number;
  /** human-readable merchant name, optional */
  merchantName?: string;
  [k: string]: unknown;
}

export interface HexeraRequirements extends PaymentRequirements {
  scheme: typeof SCHEME;
  network: HederaNetwork;
  /** price in whole voucher units, as a decimal string */
  amount: string;
  /** merchant id in the Hexera registry */
  payTo: string;
  extra: HexeraExtra;
}

export interface HexeraPayloadBody {
  vouchers: Voucher[];
  requestHash: string;
  [k: string]: unknown;
}

export interface HexeraPaymentPayload extends PaymentPayload {
  x402Version: typeof X402_VERSION;
  accepted: HexeraRequirements;
  payload: HexeraPayloadBody;
}

/** PAYMENT-RESPONSE for hexera-ecash. Deliberately no `payer`. */
export interface HexeraSettleResponse extends SettleResponse {
  spentIds?: string[];
  consensusTimestamp?: string;
}

// x402 v2 headers are base64(JSON). We use our own unicode-safe codec, which
// is wire-compatible with @x402/core/http's encode/decode helpers.
export const encodeHeader = encodeJsonB64;
export const decodeHeader = decodeJsonB64;

export function isHexeraRequirements(r: PaymentRequirements): r is HexeraRequirements {
  return r.scheme === SCHEME;
}
