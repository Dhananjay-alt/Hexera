/**
 * Minimal Hedera Mirror Node REST client. Browser-safe (fetch only).
 * Works against the public testnet mirror node or the facilitator's
 * local simulation, which serves the same paths.
 */

export interface MirrorTopicMessage {
  consensus_timestamp: string; // "seconds.nanos"
  message: string; // base64
  sequence_number: number;
  topic_id: string;
  payer_account_id?: string;
}

export interface MirrorTokenTransfer {
  token_id: string;
  account: string;
  amount: number;
}

export interface MirrorTransaction {
  transaction_id: string; // mirror format 0.0.x-s-n
  consensus_timestamp: string;
  result: string;
  name: string;
  memo_base64?: string;
  token_transfers?: MirrorTokenTransfer[];
}

/** "0.0.123@1700000000.000000001" -> "0.0.123-1700000000-000000001" */
export function toMirrorTxId(txId: string): string {
  if (!txId.includes("@")) return txId;
  const [acct, ts] = txId.split("@");
  const [s, n] = ts.split(".");
  return `${acct}-${s}-${(n ?? "0").padStart(9, "0")}`;
}

export function hashscanTxUrl(network: string, txId: string): string {
  const net = network.replace("hedera:", "");
  return `https://hashscan.io/${net}/transaction/${toMirrorTxId(txId)}`;
}

export function hashscanTopicUrl(network: string, topicId: string): string {
  return `https://hashscan.io/${network.replace("hedera:", "")}/topic/${topicId}`;
}

export function decodeMessage<T = unknown>(m: MirrorTopicMessage): T | null {
  try {
    const bin = atob(m.message);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

export class MirrorClient {
  constructor(readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async get<T>(path: string): Promise<T | null> {
    const res = await fetch(path.startsWith("http") ? path : `${this.baseUrl}${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`mirror ${res.status} ${path}`);
    return (await res.json()) as T;
  }

  /** All messages with sequence_number > afterSequence, following pagination. */
  async getTopicMessages(topicId: string, afterSequence = 0, maxPages = 50): Promise<MirrorTopicMessage[]> {
    const out: MirrorTopicMessage[] = [];
    let next: string | null = `/api/v1/topics/${topicId}/messages?limit=100&order=asc&sequencenumber=gt:${afterSequence}`;
    for (let i = 0; next && i < maxPages; i++) {
      const page: { messages: MirrorTopicMessage[]; links?: { next?: string | null } } | null = await this.get(next);
      if (!page) break;
      out.push(...page.messages);
      const n: string | null | undefined = page.links?.next;
      next = n ? (n.startsWith("http") ? n : `${this.baseUrl}${n.startsWith("/") ? "" : "/"}${n}`) : null;
    }
    return out;
  }

  async getTransaction(txId: string): Promise<MirrorTransaction | null> {
    const r = await this.get<{ transactions: MirrorTransaction[] }>(`/api/v1/transactions/${toMirrorTxId(txId)}`);
    return r?.transactions?.[0] ?? null;
  }

  /** Poll until the mirror node has indexed a transaction (it lags consensus by a few seconds). */
  async waitForTransaction(txId: string, timeoutMs = 20_000): Promise<MirrorTransaction | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tx = await this.getTransaction(txId);
      if (tx) return tx;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
  }
}
