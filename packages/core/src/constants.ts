/** x402 scheme name registered by Hexera. */
export const SCHEME = "hexera-ecash" as const;
export const X402_VERSION = 2 as const;

/** USDC on Hedera has 6 decimals. */
export const TOKEN_DECIMALS = 6;

/** Face value of one voucher: 0.001 USDC = 1,000 base units. */
export const UNIT_VALUE_BASE = 1_000n;

/**
 * What a voucher costs to buy. The 10 base-unit spread pays for HCS
 * messages and payout transfers (the facilitator pays all fees).
 */
export const UNIT_PRICE_BASE = 1_010n;

export const HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
} as const;

export type HederaNetwork = "hedera:testnet" | "hedera:mainnet" | "hedera:local";

export function formatUsdc(base: bigint | number): string {
  const b = BigInt(base);
  const whole = b / 1_000_000n;
  const frac = (b % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}
