import { sha256Hex } from "@hexera/core";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
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

interface ResponseItem {
  identifier?: unknown;
  nullifier?: unknown;
  signal_hash?: unknown;
}

/**
 * Production path. The proof is checked by the Developer Portal; the per-human
 * id is read from the one typed field that holds it, IDKit v4's
 * `ResponseItemV4.nullifier` ("RP-scoped nullifier (decimal)",
 * @worldcoin/idkit-core 4.6.0), on the `proof_of_human` response item.
 *
 * Only World ID 4.0 is accepted: the same human has different v3 and v4
 * nullifiers, so allowing both would let one person get two caps.
 */
export async function verifyWorldId(cfg: FacilitatorConfig, input: WorldIdInput, expectedSignal: string): Promise<WorldIdVerified> {
  if (input.mode === "dev") {
    // The simulator path exists only when WORLD_ID_MODE=dev; production never falls back to it.
    if (cfg.worldIdMode !== "dev") throw new WorldIdError("dev World ID proofs are disabled (WORLD_ID_MODE=production)");
    if (!input.human || typeof input.human !== "string") throw new WorldIdError("dev proof needs a human id");
    return { human: await sha256Hex(`dev:${input.human}`) };
  }
  if (cfg.worldIdMode !== "production") throw new WorldIdError("IDKit proofs need WORLD_ID_MODE=production");
  if (!cfg.worldRpId) throw new WorldIdError("WORLD_RP_ID is not configured");

  const result = (input as { result?: Record<string, unknown> }).result;
  if (!result || typeof result !== "object") throw new WorldIdError("missing IDKit result");
  if (result.protocol_version !== "4.0") throw new WorldIdError("only World ID 4.0 proofs are accepted");
  if (result.action !== cfg.worldAction) throw new WorldIdError("wrong World ID action");
  // Simulator / staging proofs carry environment "staging"; never accept them here.
  if (result.environment !== "production") throw new WorldIdError(`World ID proof is from the "${String(result.environment)}" environment, not production`);

  const responses = Array.isArray(result.responses) ? (result.responses as ResponseItem[]) : [];
  const idx = responses.findIndex((r) => r && r.identifier === "proof_of_human");
  if (idx < 0) throw new WorldIdError("no proof_of_human credential in the World ID result");
  const item = responses[idx];
  if (typeof item.nullifier !== "string" || !/^\d{1,80}$/.test(item.nullifier)) throw new WorldIdError("proof_of_human nullifier missing or not a decimal string");

  // Signal binding, checked against the proof itself (not a value the client reports).
  if (typeof item.signal_hash !== "string" || item.signal_hash.toLowerCase() !== hashSignal(expectedSignal).toLowerCase()) {
    throw new WorldIdError("proof signal does not match the depositing account");
  }

  const res = await fetch(`https://developer.worldcoin.org/api/v4/verify/${cfg.worldRpId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.success !== true) {
    throw new WorldIdError(`World ID verification failed: ${String(body.detail ?? body.code ?? res.status)}`);
  }

  const human = await sha256Hex(`world:v4:${cfg.worldAction}:${BigInt(item.nullifier).toString()}`);
  // Printed so the field can be confirmed with a real World App proof; the nullifier itself is never logged.
  console.log(`[facilitator] world id: verified proof_of_human (v4); human id read from result.responses[${idx}].nullifier; human=${human.slice(0, 12)}…`);
  return { human };
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
