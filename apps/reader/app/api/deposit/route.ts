/**
 * Demo-only deposit endpoint. It plays the role of the user's Hedera wallet
 * (HashPack etc.) signing an HTS transfer to the Hexera treasury:
 *  - local mode: asks the facilitator's simulated ledger to move test USDC
 *  - testnet mode: signs with DEMO_USER_n_KEY from .env
 * Vouchers are still blinded and stored in the browser; this route never
 * sees them.
 */
import { NextResponse } from "next/server";

const FAC = process.env.FACILITATOR_URL ?? process.env.NEXT_PUBLIC_FACILITATOR_URL ?? "http://localhost:4020";

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${FAC}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message ?? `${path} -> ${r.status}`);
  return j as T;
}

export async function POST(req: Request) {
  try {
    const { user, amountBase, dryRun } = (await req.json()) as { user: "1" | "2"; amountBase?: string; dryRun?: boolean };
    if (user !== "1" && user !== "2") return NextResponse.json({ error: "user must be 1 or 2" }, { status: 400 });
    const s = (await (await fetch(`${FAC}/supported`)).json()).hexera as { mode: string; asset: string; treasury: string };

    if (s.mode === "local") {
      const { account, balanceBase } = await post<{ account: string; balanceBase: string }>("/local/faucet", { name: `reader-user-${user}`, amountBase: "25000000" });
      if (dryRun) return NextResponse.json({ account, balanceBase });
      const { transactionId } = await post<{ transactionId: string }>("/local/deposit", { account, amountBase });
      return NextResponse.json({ account, transactionId });
    }

    const id = process.env[`DEMO_USER_${user}_ID`];
    const key = process.env[`DEMO_USER_${user}_KEY`];
    if (!id || !key) return NextResponse.json({ error: `DEMO_USER_${user}_ID/KEY not set` }, { status: 500 });
    if (dryRun) return NextResponse.json({ account: id });
    const { userDeposit } = await import("@hexera/hedera");
    const transactionId = await userDeposit({ network: "testnet", accountId: id, privateKey: key, tokenId: s.asset, treasury: s.treasury, amountBase: BigInt(amountBase ?? "0") });
    return NextResponse.json({ account: id, transactionId });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
