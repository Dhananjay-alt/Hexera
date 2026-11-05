"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, Blocks, Check, ChevronRight, Eye, EyeOff, Loader2, Lock, Newspaper, Server, ShieldCheck } from "lucide-react";
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
          <a className="logo" href="/">
            <span className="logo-glyph">
              <Lock size={11} strokeWidth={2.5} />
            </span>
            Hexera
          </a>
          <div className="topbar-end">
            <a className="navlink" href="#read">
              Publishers
            </a>
            <a className="navlink" href="#wallet">
              Wallet
            </a>
            <a className="navlink" href="#how">
              How it works
            </a>
            {info && (
              <span className="pill net-pill">
                <span className="dot dot-live" />
                {info.network} · epoch {info.currentEpoch}
              </span>
            )}
            <a className="btn btn-pill" href={AUDIT_URL} target="_blank" rel="noreferrer">
              Open the audit
            </a>
          </div>
        </div>
      </header>

      <main className="page">
        {fatal && (
          <div className="notice notice-err" role="alert" style={{ marginTop: 24 }}>
            <AlertCircle size={15} />
            <span className="msg">{fatal}</span>
          </div>
        )}

        <section className="hero">
          <div>
            <h1 className="display">
              Pay per article.
              <br />
              Leave no trail.
            </h1>
            <p className="lede">
              Every read is paid with a blind-signed voucher. The chain, the facilitator and the publisher each see that a valid payment happened. None of them see that it
              was you.
            </p>
          </div>
          <div className="hero-side">
            <a className="link-arrow" href="#how">
              How Hexera works
              <ArrowRight size={15} />
            </a>
          </div>
        </section>

        <section className="showcase" aria-label="Who saw what">
          <div className="card card-flush">
            <div className="card-head">
              <div className="pub-meta">
                <ShieldCheck size={15} color="#8a8f98" />
                <h2 className="h-card">Who saw what</h2>
                <span className="badge">{last ? `${last.publisher} · ${last.units} vouchers` : "open an article"}</span>
              </div>
              <div className="console-meta">
                <div className="m">
                  <span className="label">Vouchers</span>
                  <b>{balance.units.toLocaleString()}</b>
                </div>
                <div className="m">
                  <span className="label">Paid reads</span>
                  <b>{paid}</b>
                </div>
                <div className="m">
                  <span className="label">Publishers</span>
                  <b>{pubs.length}</b>
                </div>
              </div>
            </div>
            <ul className="rows">
              {[
                { name: "Chain", icon: <Blocks size={15} />, sees: last ? `burn ${last.tx}` : "anonymous serial burns", hides: "who paid", mono: !!last },
                { name: "Publisher", icon: <Newspaper size={15} />, sees: "a valid payment arrived", hides: "your account or deposit", mono: false },
                { name: "Facilitator", icon: <Server size={15} />, sees: "serials redeemed by a merchant", hides: "which depositor owns them", mono: false },
              ].map((r) => (
                <li key={r.name} className="party">
                  <span className="party-name">
                    {r.icon}
                    {r.name}
                  </span>
                  <span className="party-cell">
                    <span className="badge badge-ok">
                      <Eye size={12} />
                      sees
                    </span>
                    <span className={`t${r.mono ? " mono" : ""}`}>{r.sees}</span>
                  </span>
                  <span className="party-cell muted">
                    <span className="badge">
                      <EyeOff size={12} />
                      never sees
                    </span>
                    <span className="t">{r.hides}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="section" id="read">
          <div className="main-grid">
            <div className="col">
              {opened ? (
                <article className="card card-flush">
                  <nav className="crumbs" aria-label="Breadcrumb">
                    <button suppressHydrationWarning className="text-btn" onClick={() => setOpened(null)}>
                      Publishers
                    </button>
                    <ChevronRight size={13} />
                    <button suppressHydrationWarning className="text-btn" onClick={() => setOpened(null)}>
                      {opened.pub.name}
                    </button>
                    <ChevronRight size={13} />
                    <span className="cur">{opened.meta.title}</span>
                  </nav>
                  <div className="reading">
                    <span className="label">{opened.pub.name}</span>
                    <h1 className="h-sub">{opened.meta.title}</h1>
                    {opened.loading && (
                      <>
                        <div className="paying">
                          <Loader2 size={14} className="spin" />
                          402 Payment Required → paying {opened.meta.price} {opened.meta.price === 1 ? "voucher" : "vouchers"}…
                        </div>
                        <div className="skeleton" aria-hidden>
                          <div style={{ width: "92%" }} />
                          <div style={{ width: "86%" }} />
                          <div style={{ width: "62%" }} />
                        </div>
                      </>
                    )}
                    {opened.error && (
                      <div className="notice notice-err" role="alert">
                        <AlertCircle size={15} />
                        <span>
                          Payment refused <span className="msg">· {opened.error}</span>
                        </span>
                      </div>
                    )}
                    {opened.body?.map((p, i) => (
                      <p key={i} className="body">
                        {p}
                      </p>
                    ))}
                  </div>
                  {opened.tx && (
                    <div className="receipt" style={{ borderTop: "1px solid var(--color-graphite)" }}>
                      <div className="card-head">
                        <span className="h-card" style={{ fontSize: 15 }}>
                          Receipt
                        </span>
                        <span className="badge badge-ok">
                          <Check size={12} />
                          settled
                        </span>
                      </div>
                      <dl className="rows" style={{ margin: 0 }}>
                        <div className="kv">
                          <dt>Paid</dt>
                          <dd>
                            {opened.units} vouchers · {usdcOfUnits(opened.units ?? 0)} USDC
                          </dd>
                        </div>
                        <div className="kv" style={{ borderTop: "1px solid var(--color-graphite)" }}>
                          <dt>Burned on HCS</dt>
                          <dd className="mono">
                            <a href={txLink(opened.tx)} target="_blank" rel="noreferrer">
                              {opened.tx}
                            </a>
                          </dd>
                        </div>
                        <div className="kv" style={{ borderTop: "1px solid var(--color-graphite)" }}>
                          <dt>{opened.pub.name} saw</dt>
                          <dd>A valid payment. No account, no deposit, no history.</dd>
                        </div>
                      </dl>
                    </div>
                  )}
                </article>
              ) : (
                pubs.map((p) => (
                  <section key={p.id} className="card card-flush">
                    <div className="card-head">
                      <div>
                        <h2 className="h-card">{p.name}</h2>
                        <p className="label" style={{ margin: "2px 0 0" }}>
                          {p.tagline}
                        </p>
                      </div>
                      <span className="badge">{p.articles.length} articles</span>
                    </div>
                    <ul className="rows">
                      {p.articles.map((a) => (
                        <li key={a.slug}>
                          <button suppressHydrationWarning className="article-row" onClick={() => open(p, a)} disabled={!info}>
                            <span className="article-title">{a.title}</span>
                            <span className="article-teaser">{a.teaser}</span>
                            <span className="article-meta">
                              <span className="badge">
                                {a.price} {a.price === 1 ? "voucher" : "vouchers"}
                              </span>
                              <span className="mono muted">{usdcOfUnits(a.price)} USDC</span>
                              <ArrowRight size={15} className="arrow" />
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </div>

            <aside className="col aside" id="wallet">
              <section className="card">
                <div className="pub-meta" style={{ justifyContent: "space-between" }}>
                  <h2 className="h-card" style={{ fontSize: 15 }}>
                    Wallet
                  </h2>
                  <span className="badge">
                    <Lock size={11} />
                    browser only
                  </span>
                </div>
                <div className="balance" style={{ marginTop: 16 }}>
                  <span className="balance-value">{balance.units.toLocaleString()}</span>
                  <span className="label">vouchers</span>
                </div>
                <div className="balance-meta">
                  <span>{balance.usdc} USDC</span>
                  <span className="mono">{account || "…"}</span>
                </div>

                <div className="form">
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
                    <span className="input-wrap">
                      <input suppressHydrationWarning className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
                      <span>USDC</span>
                    </span>
                    {info && amountBase > freeLimit && (
                      <span className="hint">
                        Above {formatUsdc(freeLimit)} USDC a day needs one unique human. Cap: {formatUsdc(BigInt(info.limits.humanDailyCapBase))} USDC a day per human.
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
                  <button suppressHydrationWarning className="btn btn-lime btn-block" onClick={deposit} disabled={!!busy || !info || !account}>
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
                    <div className="notice notice-err deposit-error" role="alert">
                      <AlertCircle size={15} />
                      <span>
                        Refused <span className="msg">· {depositErr}</span>
                      </span>
                    </div>
                  )}
                </div>
              </section>

              <section className="card card-flush">
                <div className="card-head">
                  <span className="h-card" style={{ fontSize: 15 }}>
                    Activity
                  </span>
                  <span className="badge">{log.length}</span>
                </div>
                {log.length === 0 ? (
                  <p className="empty">Deposit, then open an article.</p>
                ) : (
                  <ul className="log">
                    {log.map((l, i) => (
                      <li key={i} className={`line ${l.kind}`}>
                        {l.kind === "err" ? (
                          <span className="badge badge-err">refused</span>
                        ) : l.kind === "ok" ? (
                          <span className="badge badge-ok">ok</span>
                        ) : (
                          <span className="badge">402</span>
                        )}
                        <span>
                          <span className="line-text">{l.text}</span>
                          <br />
                          <span className="line-at">{l.at}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          </div>
        </section>

        <section className="section">
          <div className="strip" aria-label="Built on">
            <span className="lead">Built on</span>
            <span>Hedera Consensus Service</span>
            <span>Hedera Token Service</span>
            <span>Mirror Node</span>
            <span>RFC 9474</span>
            <span>x402</span>
            <span>World ID</span>
          </div>
        </section>

        <section className="section" id="how">
          <div className="faq-head">
            <h2 className="h-section">
              Card-network privacy,
              <br />
              on a public ledger.
            </h2>
            <a className="link-arrow" href={AUDIT_URL} target="_blank" rel="noreferrer">
              Check the books yourself
              <ArrowRight size={15} />
            </a>
          </div>
          <ul className="faq">
            {[
              ["What does the chain see?", "Your one deposit to Hexera, anonymous serial hashes burned on the hexera-spent topic for each read, and a batched payout to each publisher. Nothing links your deposit to any article."],
              ["Why can't the facilitator link me?", "It signs your vouchers blind (RFC 9474): it never sees a serial until it is spent, and then it can't tell whose it was. It knows who deposited, not who read what."],
              ["What stops double spending?", "Every spent serial is written to a public HCS topic. Consensus order decides races, and the earliest timestamp wins. Anyone can check it on the audit page."],
              ["Why World ID?", "Deposits above a small free limit need one unique human, so a single person can't dodge the daily cap with many free accounts. Proof of Human is the minimum that proves it."],
            ].map(([q, a]) => (
              <li key={q}>
                <h3 className="q">{q}</h3>
                <p className="a">{a}</p>
              </li>
            ))}
          </ul>
        </section>

        <footer className="footer">
          <span>hexera-ecash · RFC 9474 blind signatures · HCS double-spend registry · HTS batch payouts</span>
          <span>No smart contracts · MIT</span>
        </footer>
      </main>
    </>
  );
}
