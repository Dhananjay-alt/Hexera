"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDot,
  EyeOff,
  Loader2,
  Lock,
  Newspaper,
  ShieldCheck,
  Wallet,
} from "lucide-react";
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
interface LastPayment {
  publisher: string;
  units: number;
  tx: string;
}

const USERS = [
  { id: "1", label: "Account A", human: "reader-human-1" },
  { id: "2", label: "Account B (same human as A)", human: "reader-human-1" },
] as const;

const usdcOfUnits = (n: number) => formatUsdc(BigInt(n) * 1000n);

// Form controls carry suppressHydrationWarning: autofill / form-filler extensions (e.g. ones that add
// `fdprocessedid`) modify inputs before React hydrates. It only silences attribute diffs on that element.
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
  const [paid, setPaid] = useState(0);
  const [last, setLast] = useState<LastPayment | null>(null);
  const [depositErr, setDepositErr] = useState<string | null>(null);

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
    setDepositErr(null);
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
    setDepositErr(null);
    setBusy("Checking limits…");
    try {
      const check = await wallet.depositCheck(account, amountBase, proof ?? undefined);
      if (!check.ok) {
        say(check.reason ?? "deposit refused", "err");
        setDepositErr(check.reason ?? "deposit refused");
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
      const msg = e instanceof HexeraError ? `${e.code}: ${e.message}` : (e as Error).message;
      say(msg, "err");
      setDepositErr(msg);
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
      if (r.unitsPaid > 0 && r.settlement?.transaction) {
        setPaid((n) => n + 1);
        setLast({ publisher: pub.name, units: r.unitsPaid, tx: r.settlement.transaction });
      }
      await refresh();
    } catch (e) {
      const msg = e instanceof HexeraError ? `${e.code}: ${e.message}` : (e as Error).message;
      say(msg, "err");
      setOpened({ pub, meta, error: msg, loading: false });
    }
  }

  const txLink = (tx: string) => (info?.mode === "testnet" ? hashscanTxUrl(info.network, tx) : `${info?.mirrorUrl}/api/v1/transactions/${tx}`);
  const shortTx = (tx: string) => (tx.length > 28 ? `${tx.slice(0, 14)}…${tx.slice(-8)}` : tx);

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/">
            <span className="brand-mark">
              <Lock size={14} strokeWidth={2} />
            </span>
            Hexera
            <span className="badge badge-soft">Reader</span>
          </a>
          <div className="topbar-actions">
            {info && (
              <span className="badge badge-outline net-badge">
                <span className="dot" />
                {info.network} · epoch {info.currentEpoch}
              </span>
            )}
            <a className="btn btn-outline" href={AUDIT_URL} target="_blank" rel="noreferrer">
              Audit
              <ArrowUpRight size={14} />
            </a>
          </div>
        </div>
      </header>

      <main className="page">
        {fatal && (
          <div className="banner" role="alert">
            <AlertCircle size={16} />
            {fatal}
          </div>
        )}

        <section className="hero">
          <div>
            <p className="eyebrow">Private x402 on Hedera</p>
            <h1 className="display">
              Pay per article.
              <br />
              Leave no trail.
            </h1>
            <p className="lede">
              Every read is paid with a blind-signed voucher. The chain, the facilitator and the publisher each see that a valid payment happened — none of them see
              that it was you.
            </p>
          </div>
          <div className="stats">
            <div>
              <div className="stat-label">Vouchers</div>
              <div className="stat-value">{balance.units.toLocaleString()}</div>
              <div className="stat-sub">{balance.usdc} USDC</div>
            </div>
            <div>
              <div className="stat-label">Paid reads</div>
              <div className="stat-value">{paid}</div>
              <div className="stat-sub">this session</div>
            </div>
            <div>
              <div className="stat-label">Publishers</div>
              <div className="stat-value">{pubs.length}</div>
              <div className="stat-sub">one wallet</div>
            </div>
          </div>
        </section>

        <div className="grid">
          <div className="col">
            {opened ? (
              <article className="card">
                <div className="article">
                  <nav className="breadcrumb" aria-label="Breadcrumb">
                    <button suppressHydrationWarning onClick={() => setOpened(null)}>Publishers</button>
                    <ChevronRight size={14} />
                    <button suppressHydrationWarning onClick={() => setOpened(null)}>{opened.pub.name}</button>
                    <ChevronRight size={14} />
                    <span className="current">{opened.meta.title}</span>
                  </nav>
                  <h1>{opened.meta.title}</h1>
                  {opened.loading && (
                    <>
                      <div className="status-line">
                        <Loader2 size={14} className="spin" />
                        402 Payment Required → paying {opened.meta.price} {opened.meta.price === 1 ? "voucher" : "vouchers"}…
                      </div>
                      <div className="skeleton" aria-hidden>
                        <div style={{ width: "92%" }} />
                        <div style={{ width: "86%" }} />
                        <div style={{ width: "64%" }} />
                      </div>
                    </>
                  )}
                  {opened.error && (
                    <p className="error-text" role="alert">
                      <AlertCircle size={16} />
                      {opened.error}
                    </p>
                  )}
                  {opened.body?.map((p, i) => <p key={i}>{p}</p>)}
                </div>
                {opened.tx && (
                  <div className="card-footer">
                    <div className="receipt">
                      <div className="receipt-item">
                        <div className="k">Paid</div>
                        <div className="v">
                          {opened.units} vouchers · {usdcOfUnits(opened.units ?? 0)} USDC
                        </div>
                      </div>
                      <div className="receipt-item">
                        <div className="k">Burned on HCS</div>
                        <div className="v mono">
                          <a href={txLink(opened.tx)} target="_blank" rel="noreferrer">
                            {opened.tx}
                          </a>
                        </div>
                      </div>
                      <div className="receipt-item">
                        <div className="k">{opened.pub.name} saw</div>
                        <div className="v">A valid payment. No account, no deposit, no history.</div>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            ) : (
              pubs.map((p) => (
                <section key={p.id} className="card">
                  <div className="card-header">
                    <div className="pub-head">
                      <span className="icon-chip">
                        <Newspaper size={16} />
                      </span>
                      <div>
                        <h2 className="card-title">{p.name}</h2>
                        <p className="card-desc">{p.tagline}</p>
                      </div>
                    </div>
                    <span className="badge badge-soft">{p.articles.length} articles</span>
                  </div>
                  <ul className="article-list">
                    {p.articles.map((a) => (
                      <li key={a.slug}>
                        <button suppressHydrationWarning className="article-row" onClick={() => open(p, a)} disabled={!info}>
                          <span className="article-title">{a.title}</span>
                          <span className="article-teaser">{a.teaser}</span>
                          <span className="article-meta">
                            <span className="badge badge-outline">
                              {a.price} {a.price === 1 ? "voucher" : "vouchers"}
                            </span>
                            <span className="mono">{usdcOfUnits(a.price)} USDC</span>
                            <ChevronRight size={16} className="chev" />
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>

          <aside className="col aside">
            <section className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">Wallet</h2>
                  <p className="card-desc">Vouchers live only in this browser.</p>
                </div>
                <span className="icon-chip">
                  <Wallet size={16} />
                </span>
              </div>
              <div className="card-body stack">
                <div>
                  <div className="balance">
                    <span className="balance-value">{balance.units.toLocaleString()}</span>
                    <span className="balance-unit">vouchers</span>
                  </div>
                  <div className="wallet-meta">
                    <span>= {balance.usdc} USDC</span>
                    <span className="mono">{account || "…"}</span>
                  </div>
                </div>
                <div className="divider" />
                <label className="field">
                  <span className="field-label">Demo account</span>
                  <select suppressHydrationWarning className="select" value={user} onChange={(e) => setUser(e.target.value as "1" | "2")}>
                    {USERS.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                  {walletBal && <span className="hint">On-chain balance {formatUsdc(BigInt(walletBal))} USDC</span>}
                </label>
                <label className="field">
                  <span className="field-label">Deposit</span>
                  <span className="input-suffix">
                    <input suppressHydrationWarning className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
                    <span>USDC</span>
                  </span>
                  {info && amountBase > freeLimit && (
                    <span className="hint">
                      Above {formatUsdc(freeLimit)} USDC/day needs one unique human · cap {formatUsdc(BigInt(info.limits.humanDailyCapBase))} USDC/day per human
                    </span>
                  )}
                </label>
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
                <button suppressHydrationWarning className="btn btn-primary btn-block" onClick={deposit} disabled={!!busy || !info || !account}>
                  {busy ? (
                    <>
                      <Loader2 size={14} className="spin" />
                      {busy}
                    </>
                  ) : (
                    `Deposit ${amount} USDC`
                  )}
                </button>
                {depositErr && (
                  <p className="hint error-text" role="alert">
                    <AlertCircle size={14} />
                    {depositErr}
                  </p>
                )}
              </div>
            </section>

            <section className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">Who saw what</h2>
                  <p className="card-desc">{last ? `Your last read: ${last.publisher}, ${last.units} vouchers` : "Open an article to see each party's view."}</p>
                </div>
                <span className="icon-chip">
                  <ShieldCheck size={16} />
                </span>
              </div>
              <div className="card-body">
                <ul className="parties">
                  {[
                    { name: "Chain", sees: last ? `Burn ${shortTx(last.tx)}` : "Anonymous serial burns", hides: "Who paid" },
                    { name: "Publisher", sees: "A valid payment", hides: "Your account or deposit" },
                    { name: "Facilitator", sees: "Serials redeemed by a merchant", hides: "Which depositor owns them" },
                  ].map((r) => (
                    <li key={r.name} className="party">
                      <span className="party-name">{r.name}</span>
                      <span className="party-sees">
                        <span className="sees">
                          <Check size={14} />
                          <span className={r.name === "Chain" && last ? "mono" : undefined}>{r.sees}</span>
                        </span>
                        <span className="hidden">
                          <EyeOff size={14} />
                          {r.hides}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <section className="card">
              <div className="card-header">
                <h2 className="card-title">Activity</h2>
                <span className="badge badge-soft">{log.length}</span>
              </div>
              <div className="card-body">
                {log.length === 0 ? (
                  <p className="empty">Deposit, then open an article.</p>
                ) : (
                  <ul className="log">
                    {log.map((l, i) => (
                      <li key={i} className={`line ${l.kind}`}>
                        {l.kind === "err" ? <AlertCircle size={14} /> : l.kind === "ok" ? <Check size={14} /> : <CircleDot size={14} />}
                        <span>
                          <span className="line-text">{l.text}</span>
                          <br />
                          <span className="line-at">{l.at}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </aside>
        </div>

        <footer className="footer">
          <span>hexera-ecash · RFC 9474 blind signatures · HCS double-spend registry · HTS batch payouts</span>
          <span>No smart contracts · MIT</span>
        </footer>
      </main>
    </>
  );
}
