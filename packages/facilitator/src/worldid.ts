import { sha256Hex } from "@hexera/core";
import type { FacilitatorConfig } from "./config";

/**
 * Proof of Human for the deposit cap. We only need "one unique human", so
 * the per-app, per-action nullifier is all we keep (hashed). The proof's
 * signal is the depositing Hedera account, so a proof can't be replayed to
 * charge someone else's account against your cap.
 */
export type WorldIdInput =
  | { mode: "dev"; human: string; signal?: string }
  | { mode?: "idkit"; result: Record<string, unknown>; signal?: string };

export interface WorldIdVerified {
  /** sha256(nullifier) — stable per human for this app+action */
  human: string;
}

export class WorldIdError extends Error {}

function findNullifier(o: unknown, depth = 0): string | undefined {
  if (!o || typeof o !== "object" || depth > 6) return;
  for (const [k, v] of Object.entries(o)) {
    if (/^nullifier(_hash)?$/i.test(k) && (typeof v === "string" || typeof v === "number" || typeof v === "bigint")) return String(v);
  }
  for (const v of Object.values(o)) {
    const hit = findNullifier(v, depth + 1);
    if (hit) return hit;
  }
}

export async function verifyWorldId(cfg: FacilitatorConfig, input: WorldIdInput, expectedSignal: string): Promise<WorldIdVerified> {
  if (input.mode === "dev") {
    if (cfg.worldIdMode !== "dev") throw new WorldIdError("dev World ID proofs are disabled (WORLD_ID_MODE=production)");
    if (!input.human || typeof input.human !== "string") throw new WorldIdError("dev proof needs a human id");
    return { human: await sha256Hex(`dev:${input.human}`) };
  }

  if (!cfg.worldRpId) throw new WorldIdError("WORLD_RP_ID is not configured");
  const result = input.result;
  if (!result || typeof result !== "object") throw new WorldIdError("missing IDKit result");
  if (result.action !== undefined && result.action !== cfg.worldAction) throw new WorldIdError("wrong World ID action");

  const res = await fetch(`https://developer.worldcoin.org/api/v4/verify/${cfg.worldRpId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.success === false) {
    throw new WorldIdError(`World ID verification failed: ${String(body.detail ?? body.code ?? res.status)}`);
  }
  // Signal binding: the client must request the proof with signal = account id.
  if (input.signal !== undefined && input.signal !== expectedSignal) throw new WorldIdError("proof signal does not match deposit account");

  const nullifier = findNullifier(body) ?? findNullifier(result);
  if (!nullifier) throw new WorldIdError("no nullifier in World ID response");
  return { human: await sha256Hex(`world:${cfg.worldAction}:${nullifier}`) };
}

/** RP signature so the IDKit widget can open a request (v4 flow). */
export async function rpContext(cfg: FacilitatorConfig) {
  if (!cfg.worldRpId || !cfg.worldRpSigningKey) return null;
  const { signRequest } = await import("@worldcoin/idkit-core/signing");
  const sig = signRequest({ action: cfg.worldAction, signingKeyHex: cfg.worldRpSigningKey });
  return {
    rp_id: cfg.worldRpId,
    nonce: sig.nonce,
    created_at: sig.createdAt,
    expires_at: sig.expiresAt,
    signature: sig.sig,
  };
}
