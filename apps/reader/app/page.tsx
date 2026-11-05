"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { HexeraError, type SupportedInfo, type WorldIdProof } from "@hexera/client";
import { formatUsdc } from "@hexera/core";
import { hashscanTxUrl } from "@hexera/hedera/mirror";
import { AUDIT_URL, PUBLISHERS, getWallet } from "@/lib/wallet";
import { WorldIdButton } from "./WorldIdButton";

interface ArticleMeta {
  slug: string;
  title: string;
  teaser: string;
  price: number;
  url: string;
}
interface Catalogue {
  base: string;
  id: string;
  name: string;
  tagline: string;
  articles: ArticleMeta[];
}
interface Opened {
  pub: Catalogue;
  meta: ArticleMeta;
  body?: string[];
  error?: string;
  units?: number;
  tx?: string;
  loading: boolean;
}
interface LogLine {
  at: string;
  text: string;
  kind: "info" | "ok" | "err";
}

const USERS = [
  { id: "1", label: "Account A", human: "reader-human-1" },
  { id: "2", label: "Account B (same human as A)", human: "reader-human-1" },
] as const;

export default function Reader() {
  const [info, setInfo] = useState<SupportedInfo | null>(null);
  const [pubs, setPubs] = useState<Catalogue[]>([]);
  const [user, setUser] = useState<"1" | "2">("1");
  const [account, setAccount] = useState<string>("");
  const [walletBal, setWalletBal] = useState<string | null>(null);
  const [balance, setBalance] = useState({ units: 0, usdc: "0.000" });
  const [amount, setAmount] = useState("0.20");
  const [proof, setProof] = useState<WorldIdProof | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);

  const wallet = useMemo(() => getWallet(user), [user]);
  const say = useCallback((text: string, kind: LogLine["kind"] = "info") => {
    setLog((l) => [{ at: new Date().toLocaleTimeString(), text, kind }, ...l].slice(0, 60));
  }, []);

  const refresh = useCallback(async () => {
    const b = await wallet.balance();
    setBalance({ units: b.units, usdc: b.usdc });
  }, [wallet]);

  // Facilitator info + publisher catalogues (free endpoints).
  useEffect(() => {
    wallet
      .supported()
      .then(setInfo)
      .catch(() => setFatal("Can't reach the facilitator. Start everything with `npm run dev`."));
    Promise.all(
      PUBLISHERS.map(async (base) => {
        const c = await (await fetch(base)).json();
        return { ...c, base } as Catalogue;
      }),
    )
      .then(setPubs)
      .catch(() => say("could not load a publisher catalogue", "err"));
  }, [wallet, say]);

  // Demo account info.
  useEffect(() => {
    setProof(null);
    refresh().catch(() => {});
    fetch("/api/deposit", { method: "POST", body: JSON.stringify({ user, dryRun: true }) })
      .then((r) => r.json())
      .then((j) => {
        setAccount(j.account ?? "");
        setWalletBal(j.balanceBase ?? null);
      })
      .catch(() => {});
  }, [user, refresh]);

  const amountBase = BigInt(Math.round(Number(amount || "0") * 1_000_000));
  const freeLimit = info ? BigInt(info.limits.freeDailyLimitBase) : 0n;

  async function deposit() {
    if (!info || amountBase <= 0n) return;
    setBusy("Checking limits…");
    try {
      const check = await wallet.depositCheck(account, amountBase, proof ?? undefined);
      if (!check.ok) {
        say(check.reason ?? "deposit refused", "err");
        return;
      }
      setBusy("Sending USDC to the Hexera treasury…");
      const r = await fetch("/api/deposit", { method: "POST", body: JSON.stringify({ user, amountBase: amountBase.toString() }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      say(`deposit tx ${j.transactionId} (${formatUsdc(amountBase)} USDC) — public: "account ${j.account} deposited to Hexera"`, "ok");
      setBusy("Blinding vouchers and buying them…");
      const res = await wallet.redeemDeposit(j.transactionId, proof ?? undefined, (d, t) => setBusy(`Blinding and buying vouchers… ${d}/${t}`));
      say(`${res.units} vouchers bought blind — the facilitator never saw their serials`, "ok");
      await refresh();
      const d = await fetch("/api/deposit", { method: "POST", body: JSON.stringify({ user, dryRun: true }) }).then((x) => x.json());
      setWalletBal(d.balanceBase ?? null);
    } catch (e) {
      say(e instanceof HexeraError ? `${e.code}: ${e.message}` : (e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  }

  async function open(pub: Catalogue, meta: ArticleMeta) {
    setOpened({ pub, meta, loading: true });
    const url = `${pub.base}${meta.url}`;
    say(`GET ${pub.name} / ${meta.slug} → 402 PAYMENT-REQUIRED (${meta.price} units)`);
    try {
      const r = await wallet.fetch(url);
      if (!r.response.ok) throw new Error(`HTTP ${r.response.status}`);
      const j = (await r.response.json()) as { body: string[] };
      say(`paid ${r.unitsPaid} vouchers → 200 OK. ${pub.name} learned: "a valid payment arrived"`, "ok");
      setOpened({ pub, meta, body: j.body, units: r.unitsPaid, tx: r.settlement?.transaction, loading: false });
      await refresh();
    } catch (e) {
      const msg = e instanceof HexeraError ? `${e.code}: ${e.message}` : (e as Error).message;
      say(msg, "err");
      setOpened({ pub, meta, error: msg, loading: false });
    }
  }

  const txLink = (tx: string) => (info?.mode === "testnet" ? hashscanTxUrl(info.network, tx) : `${info?.mirrorUrl}/api/v1/transactions/${tx}`);

  return (
    <main>
      <header>
        <div>
          <h1>
            Hexera <span>Reader</span>
          </h1>
          <p className="tag">Pay per article without publishing your reading history.</p>
        </div>
        <nav>
          {info && (
            <span className="pill">
              {info.mode} · {info.network} · epoch {info.currentEpoch}
            </span>
          )}
          <a href={AUDIT_URL} target="_blank" rel="noreferrer">
            Audit page ↗
          </a>
        </nav>
      </header>
      {fatal && <div className="banner err">{fatal}</div>}

      <div className="grid">
        <section className="content">
          {opened ? (
            <article className="reader">
              <button className="link" onClick={() => setOpened(null)}>
                ← back to publishers
              </button>
              <p className="kicker">{opened.pub.name}</p>
              <h2>{opened.meta.title}</h2>
              {opened.loading && <p className="muted">402 → paying with vouchers → …</p>}
              {opened.error && <p className="err">{opened.error}</p>}
              {opened.body?.map((p, i) => <p key={i}>{p}</p>)}
              {opened.tx && (
                <div className="receipt">
                  <div>
                    <b>Paid</b> {opened.units} vouchers ({formatUsdc(BigInt(opened.units ?? 0) * 1000n)} USDC)
                  </div>
                  <div>
                    <b>Burned on HCS</b>{" "}
                    <a href={txLink(opened.tx)} target="_blank" rel="noreferrer">
                      {opened.tx}
                    </a>
                  </div>
                  <div>
                    <b>{opened.pub.name} saw</b> a valid payment. No account, no deposit, no history.
                  </div>
                </div>
              )}
            </article>
          ) : (
            pubs.map((p) => (
              <div key={p.id} className="pub">
                <h3>{p.name}</h3>
                <p className="muted">{p.tagline}</p>
                <ul>
                  {p.articles.map((a) => (
                    <li key={a.slug}>
                      <button className="article" onClick={() => open(p, a)} disabled={!info}>
                        <span className="title">{a.title}</span>
                        <span className="teaser">{a.teaser}</span>
                        <span className="price">
                          {a.price} {a.price === 1 ? "voucher" : "vouchers"} · {formatUsdc(BigInt(a.price) * 1000n)} USDC
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>

        <aside>
          <div className="card wallet">
            <h3>Wallet</h3>
            <label>
              Demo account
              <select value={user} onChange={(e) => setUser(e.target.value as "1" | "2")}>
                {USERS.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="muted small">
              Hedera account {account || "…"}
              {walletBal && ` · ${formatUsdc(BigInt(walletBal))} USDC`}
            </div>
            <div className="balance">
              <b>{balance.units}</b> vouchers <span className="muted">= {balance.usdc} USDC, stored only in this browser</span>
            </div>

            <label>
              Deposit (USDC)
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </label>
            {info && amountBase > freeLimit && (
              <p className="small muted">
                Above {formatUsdc(freeLimit)} USDC/day needs one unique human (cap {formatUsdc(BigInt(info.limits.humanDailyCapBase))} USDC/day per human).
              </p>
            )}
            {info && (
              <WorldIdButton
                mode={info.worldId.mode}
                appId={info.worldId.appId}
                action={info.worldId.action}
                signal={account}
                devHuman={USERS.find((u) => u.id === user)!.human}
                proof={proof}
                onProof={setProof}
              />
            )}
            <button className="primary" onClick={deposit} disabled={!!busy || !info || !account}>
              {busy ?? `Deposit ${amount} USDC`}
            </button>
          </div>

          <div className="card log">
            <h3>Activity</h3>
            {log.length === 0 && <p className="muted small">Deposit, then open an article.</p>}
            {log.map((l, i) => (
              <div key={i} className={`line ${l.kind}`}>
                <span className="at">{l.at}</span> {l.text}
              </div>
            ))}
          </div>
        </aside>
      </div>
      <footer className="muted small">
        hexera-ecash · RFC 9474 blind signatures · HCS double-spend registry · HTS batch payouts · no smart contracts · MIT
      </footer>
    </main>
  );
}
