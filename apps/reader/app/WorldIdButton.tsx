"use client";
import { useState } from "react";
import { AlertCircle, Fingerprint, ShieldCheck, X } from "lucide-react";
import { IDKitRequestWidget, proofOfHuman } from "@worldcoin/idkit";
import type { WorldIdProof } from "@hexera/client";
import { FACILITATOR_URL } from "@/lib/wallet";

interface Props {
  mode: "dev" | "production";
  appId: string | null;
  action: string;
  /** the depositing Hedera account; bound into the proof as its signal */
  signal: string;
  /** dev mode: which simulated human is at the keyboard */
  devHuman: string;
  proof: WorldIdProof | null;
  onProof: (p: WorldIdProof | null) => void;
}

export function WorldIdButton({ mode, appId, action, signal, devHuman, proof, onProof }: Props) {
  const [open, setOpen] = useState(false);
  const [rpContext, setRpContext] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (proof) {
    return (
      <div className="worldid-ok">
        <span>
          <ShieldCheck size={14} />
          Proof of Human verified{proof.mode === "dev" ? " · simulator" : ""}
        </span>
        <button suppressHydrationWarning className="btn btn-secondary" style={{ height: 26, padding: "0 8px" }} onClick={() => onProof(null)} aria-label="Clear World ID proof">
          <X size={12} />
        </button>
      </div>
    );
  }

  if (mode === "dev") {
    return (
      <div className="field">
        <button suppressHydrationWarning className="btn btn-outline btn-block" onClick={() => onProof({ mode: "dev", human: devHuman, signal })}>
          <Fingerprint size={14} />
          Verify with World ID (dev simulator)
        </button>
        <p className="hint">Set WORLD_ID_MODE=production with WORLD_APP_ID and WORLD_RP_ID to use World App.</p>
      </div>
    );
  }

  const start = async () => {
    setErr(null);
    const r = await fetch(`${FACILITATOR_URL}/worldid/rp-context`, { method: "POST" });
    const j = await r.json();
    if (!r.ok) return setErr(j.message ?? "World ID not configured");
    setRpContext(j.rp_context);
    setOpen(true);
  };

  return (
    <div className="field">
      <button suppressHydrationWarning className="btn btn-outline btn-block" onClick={start}>
        <Fingerprint size={14} />
        Verify with World ID
      </button>
      {err && (
        <p className="hint error-text" role="alert">
          <AlertCircle size={14} />
          {err}
        </p>
      )}
      {rpContext && appId && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={appId as `app_${string}`}
          action={action}
          rp_context={rpContext as never}
          // v4 only: the same human has different v3 and v4 nullifiers, which would double the cap.
          allow_legacy_proofs={false}
          preset={proofOfHuman({ signal })}
          onSuccess={(result) => onProof({ mode: "idkit", result: result as unknown as Record<string, unknown>, signal })}
          onError={(code) => setErr(`World ID error: ${code}`)}
        />
      )}
    </div>
  );
}
