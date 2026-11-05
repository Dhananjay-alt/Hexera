"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, ArrowUpRight, Check, ChevronRight, CircleDot, Eye, EyeOff, Loader2, Sprout, Wallet } from "lucide-react";
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
      <header className="nav">
        <a className="brand" href="/">
          <Sprout size={22} strokeWidth={1.5} />
          Hexera
        </a>
        <nav className="nav-links" aria-label="Sections">
          <a href="#read">Publishers</a>
          <a href="#wallet">Wallet</a>
          <a href="#how">How it works</a>
        </nav>
        <div className="nav-end">
          {info && (
            <span className="badge badge-sm badge-line net-badge">
              <span className="dot" />
              {info.network} · epoch {info.currentEpoch}
            </span>
          )}
          <a className="btn btn-forest" href={AUDIT_URL} target="_blank" rel="noreferrer">
            Open the audit
            <ArrowUpRight size={16} strokeWidth={1.5} />
          </a>
        </div>
      </header>

      <main className="page">
        {fatal && (
          <div className="notice panel-keylime" role="alert" style={{ marginBottom: 14 }}>
            <AlertCircle size={16} />
            <span>
              <b>Not connected.</b> {fatal}
            </span>
          </div>
        )}

        <section className="hero">
          <div className="panel panel-keylime hero-main">
            <div>
              <p className="eyebrow">Private x402 on Hedera</p>
              <h1 className="display">
                Pay per article.
                <br />
                Leave no trail.
              </h1>
              <p className="lede">
                Every read is paid with a blind-signed voucher. The chain, the facilitator and the publisher each see that a valid payment happened. None of them see
                that it was you.
              </p>
              <div className="hero-cta">
                <a className="btn btn-forest" href="#wallet">
                  Deposit and start reading
                  <ArrowRight size={16} strokeWidth={1.5} />
                </a>
                <a className="btn btn-paper" href="#how">
                  How it works
                </a>
              </div>
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
          </div>

          <div className="panel panel-slate preview" aria-label="Who saw what">
            <div className="preview-head">
              <p className="eyebrow" style={{ margin: 0 }}>
                Who saw what
              </p>
              <span className="badge badge-sm">{last ? `${last.publisher} · ${last.units} vouchers` : "Open an article"}</span>
            </div>
            {[
              { name: "The chain", sees: last ? `Burn ${shortTx(last.tx)}` : "Anonymous serial burns", hides: "Who paid", mono: !!last },
              { name: "The publisher", sees: "A valid payment arrived", hides: "Your account or deposit", mono: false },
              { name: "The facilitator", sees: "Serials redeemed by a merchant", hides: "Which depositor owns them", mono: false },
            ].map((r) => (
              <div key={r.name} className="preview-card">
                <div className="who">
                  <h3 className="h-sm">{r.name}</h3>
                </div>
                <span className="sees">
                  <Eye size={15} strokeWidth={1.5} />
                  <span className={r.mono ? "mono" : undefined}>{r.sees}</span>
                </span>
                <span className="hides">
                  <EyeOff size={15} strokeWidth={1.5} />
                  {r.hides}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="section" id="read">
          <div className="main-grid">
            <div className="col">
              {opened ? (
                <article className="panel panel-keylime">
                  <nav className="crumbs" aria-label="Breadcrumb">
                    <button suppressHydrationWarning onClick={() => setOpened(null)}>
                      Publishers
                    </button>
                    <ChevronRight size={14} strokeWidth={1.5} />
                    <button suppressHydrationWarning onClick={() => setOpened(null)}>
                      {opened.pub.name}
                    </button>
                    <ChevronRight size={14} strokeWidth={1.5} />
                    <span>{opened.meta.title}</span>
                  </nav>
                  <div className="paper reading">
                    <p className="eyebrow">{opened.pub.name}</p>
                    <h1 className="h">{opened.meta.title}</h1>
                    {opened.loading && (
                      <>
                        <div className="paying">
                          <Loader2 size={16} strokeWidth={1.5} className="spin" />
                          402 Payment Required: paying {opened.meta.price} {opened.meta.price === 1 ? "voucher" : "vouchers"}…
                        </div>
                        <div className="ghost-lines" aria-hidden>
                          <div style={{ width: "92%" }} />
                          <div style={{ width: "84%" }} />
                          <div style={{ width: "60%" }} />
                        </div>
                      </>
                    )}
                    {opened.error && (
                      <div className="notice panel-keylime" role="alert">
                        <AlertCircle size={16} />
                        <span>
                          <b>Payment refused.</b> {opened.error}
                        </span>
                      </div>
                    )}
                    {opened.body?.map((p, i) => <p key={i}>{p}</p>)}
                  </div>
                  {opened.tx && (
                    <div className="panel panel-slate" style={{ marginTop: 14, padding: 28 }}>
                      <p className="eyebrow" style={{ margin: 0 }}>
                        Receipt
                      </p>
                      <div className="receipt">
                        <div className="paper">
                          <span className="field-label">Paid</span>
                          <span className="v">
                            {opened.units} vouchers · {usdcOfUnits(opened.units ?? 0)} USDC
                          </span>
                        </div>
                        <div className="paper">
                          <span className="field-label">Burned on HCS</span>
                          <a className="v mono" href={txLink(opened.tx)} target="_blank" rel="noreferrer">
                            {opened.tx}
                          </a>
                        </div>
                        <div className="paper">
                          <span className="field-label">{opened.pub.name} saw</span>
                          <span className="v">A valid payment. No account, no deposit, no history.</span>
                        </div>
                      </div>
                    </div>
                  )}
                </article>
              ) : (
                pubs.map((p, i) => (
                  <section key={p.id} className={`panel ${i % 2 === 0 ? "panel-keylime" : "panel-mint"}`}>
                    <div className="pub-head">
                      <div>
                        <p className="eyebrow">Publisher</p>
                        <h2 className="h">{p.name}</h2>
                        <p className="muted" style={{ margin: "4px 0 0" }}>
                          {p.tagline}
                        </p>
                      </div>
                      <span className="badge">{p.articles.length} articles</span>
                    </div>
                    <ul className="article-list">
                      {p.articles.map((a) => (
                        <li key={a.slug}>
                          <button suppressHydrationWarning className="article-row" onClick={() => open(p, a)} disabled={!info}>
                            <span className="article-title">{a.title}</span>
                            <span className="article-teaser">{a.teaser}</span>
                            <span className="article-meta">
                              <span className="badge badge-sm">
                                {a.price} {a.price === 1 ? "voucher" : "vouchers"}
                              </span>
                              <span className="mono">{usdcOfUnits(a.price)} USDC</span>
                              <ArrowRight size={16} strokeWidth={1.5} />
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </div>

            <aside className="col" id="wallet">
              <section className="panel panel-sage">
                <div className="wallet-head">
                  <div>
                    <p className="eyebrow">Wallet</p>
                    <h2 className="h-sm">Vouchers live only in this browser.</h2>
                  </div>
                  <Wallet size={22} strokeWidth={1.5} color="#0f3e17" />
                </div>
                <div className="balance">
                  <span className="balance-value">{balance.units.toLocaleString()}</span>
                  <span className="field-label">vouchers</span>
                </div>
                <div className="balance-meta">
                  <span>= {balance.usdc} USDC</span>
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
                  <button suppressHydrationWarning className="btn btn-forest btn-block" onClick={deposit} disabled={!!busy || !info || !account}>
                    {busy ? (
                      <>
                        <Loader2 size={16} strokeWidth={1.5} className="spin" />
                        {busy}
                      </>
                    ) : (
                      <>
                        Deposit {amount} USDC
                        <ArrowRight size={16} strokeWidth={1.5} />
                      </>
                    )}
                  </button>
                  {depositErr && (
                    <div className="notice deposit-error" role="alert">
                      <AlertCircle size={16} />
                      <span>
                        <b>Refused.</b> {depositErr}
                      </span>
                    </div>
                  )}
                </div>
              </section>

              <section className="panel panel-mint" style={{ padding: 28 }}>
                <div className="wallet-head">
                  <div>
                    <p className="eyebrow">Activity</p>
                    <h2 className="h-sm">What just happened</h2>
                  </div>
                  <span className="badge badge-sm">{log.length}</span>
                </div>
                {log.length === 0 ? (
                  <p className="empty">Deposit, then open an article.</p>
                ) : (
                  <ul className="log">
                    {log.map((l, i) => (
                      <li key={i} className={`line ${l.kind}`}>
                        {l.kind === "err" ? <AlertCircle size={15} /> : l.kind === "ok" ? <Check size={15} /> : <CircleDot size={15} strokeWidth={1.5} />}
                        <span>
                          <span className="line-text">
                            {l.kind === "err" && "Refused: "}
                            {l.text}
                          </span>
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

        <div className="strip" aria-label="Built on">
          <span>Hedera Consensus Service</span>
          <span>Hedera Token Service</span>
          <span>Mirror Node</span>
          <span>RFC 9474</span>
          <span>x402</span>
          <span>World ID</span>
        </div>

        <section className="section" id="how">
          <p className="eyebrow">How it works</p>
          <h2 className="h-lg">Card-network privacy, on a public ledger.</h2>
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
