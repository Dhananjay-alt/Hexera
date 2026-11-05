import {
  HEADERS,
  SCHEME,
  X402_VERSION,
  computeRequestHash,
  decodeHeader,
  encodeHeader,
  type HederaNetwork,
  type HexeraPaymentPayload,
  type HexeraRequirements,
  type HexeraSettleResponse,
  type PaymentRequired,
  type PaymentRequirements,
  type VerifyResponse,
} from "@hexera/core";

export interface MerchantOptions {
  facilitatorUrl: string;
  /** id in the facilitator's merchant registry */
  merchantId: string;
  merchantName?: string;
  /** Other x402 options to advertise beside hexera-ecash (e.g. the standard `exact` scheme). */
  extraAccepts?: PaymentRequirements[];
  log?: (msg: string) => void;
}

export interface PaywallRequest {
  method: string;
  /** path + query, exactly as the client requested it */
  pathWithQuery: string;
  /** absolute URL, for the resource description */
  url: string;
  body: string | Uint8Array;
  header(name: string): string | undefined;
}

export type PaywallResult =
  | { kind: "payment_required"; status: 402; headers: Record<string, string>; body: PaymentRequired }
  | { kind: "paid"; headers: Record<string, string>; settlement: HexeraSettleResponse }
  | { kind: "error"; status: number; headers: Record<string, string>; body: unknown };

interface Supported {
  network: HederaNetwork;
  asset: string;
  currentEpoch: number;
}

/**
 * Merchant side of hexera-ecash: builds 402 responses and verifies + settles
 * PAYMENT-SIGNATURE through the facilitator. Framework agnostic; see
 * hexeraPaywall() for Express.
 */
export class HexeraMerchant {
  private supported: { at: number; v: Supported } | null = null;
  private log: (m: string) => void;

  constructor(readonly opts: MerchantOptions) {
    this.opts = { ...opts, facilitatorUrl: opts.facilitatorUrl.replace(/\/$/, "") };
    this.log = opts.log ?? ((m) => console.log(`[merchant:${opts.merchantId}] ${m}`));
  }

  private async facilitator<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.opts.facilitatorUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok && res.status >= 500) throw new Error(`facilitator ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  private async info(): Promise<Supported> {
    if (this.supported && Date.now() - this.supported.at < 60_000) return this.supported.v;
    const s = await this.facilitator<{ hexera: Supported }>("/supported");
    this.supported = { at: Date.now(), v: s.hexera };
    return s.hexera;
  }

  async requirements(price: number): Promise<HexeraRequirements> {
    if (!Number.isInteger(price) || price < 1) throw new Error("price must be a positive whole number of units");
    const s = await this.info();
    return {
      scheme: SCHEME,
      network: s.network,
      amount: String(price),
      asset: s.asset,
      payTo: this.opts.merchantId,
      maxTimeoutSeconds: 60,
      extra: { facilitator: this.opts.facilitatorUrl, epoch: s.currentEpoch, merchantName: this.opts.merchantName },
    };
  }

  private async paymentRequired(req: PaywallRequest, price: number, description: string | undefined, error?: string) {
    const r = await this.requirements(price);
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(error ? { error } : {}),
      resource: { url: req.url, description: description ?? "", mimeType: "application/json" },
      accepts: [r, ...(this.opts.extraAccepts ?? [])],
    };
    return { kind: "payment_required" as const, status: 402 as const, headers: { [HEADERS.required]: encodeHeader(body) }, body };
  }

  async handle(req: PaywallRequest, price: number, description?: string): Promise<PaywallResult> {
    const sigHeader = req.header(HEADERS.signature) ?? req.header("X-PAYMENT");
    if (!sigHeader) return this.paymentRequired(req, price, description);

    let payload: HexeraPaymentPayload;
    try {
      payload = decodeHeader<HexeraPaymentPayload>(sigHeader);
    } catch {
      return this.paymentRequired(req, price, description, "malformed PAYMENT-SIGNATURE");
    }
    if (payload?.accepted?.scheme !== SCHEME) return this.paymentRequired(req, price, description, `only ${SCHEME} is accepted here`);

    const requirements = await this.requirements(price);
    // The client bound its vouchers to this exact request; refuse a lifted payload before touching the facilitator.
    const expected = await computeRequestHash(req.method, req.pathWithQuery, req.body);
    if (payload.payload?.requestHash !== expected) return this.paymentRequired(req, price, description, "requestHash does not match this request");

    const v = await this.facilitator<VerifyResponse>("/verify", { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: requirements });
    if (!v.isValid) {
      this.log(`rejected payment: ${v.invalidReason}`);
      return this.paymentRequired(req, price, description, v.invalidReason ?? "invalid payment");
    }
    const s = await this.facilitator<HexeraSettleResponse>("/settle", { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: requirements });
    if (!s.success) {
      this.log(`settlement failed: ${s.errorReason}`);
      return this.paymentRequired(req, price, description, s.errorReason ?? "settlement failed");
    }
    this.log(`paid ${price} unit(s) for ${req.method} ${req.pathWithQuery} — hcs tx ${s.transaction} — payer: unknown`);
    return { kind: "paid", headers: { [HEADERS.response]: encodeHeader(s) }, settlement: s };
  }
}
