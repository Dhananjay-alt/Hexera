// Hexera audit page: reads hexera-spent and hexera-ledger from a mirror node.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usdc = (base) => (Number(base) / 1e6).toFixed(6);

async function messages(mirror, topic) {
  const out = [];
  let next = `${mirror}/api/v1/topics/${topic}/messages?limit=100&order=asc`;
  for (let i = 0; next && i < 100; i++) {
    const r = await fetch(next);
    if (!r.ok) throw new Error(`mirror ${r.status} for topic ${topic}`);
    const page = await r.json();
    for (const m of page.messages) {
      try {
        const bytes = Uint8Array.from(atob(m.message), (c) => c.charCodeAt(0));
        out.push({ seq: m.sequence_number, ts: m.consensus_timestamp, d: JSON.parse(new TextDecoder().decode(bytes)) });
      } catch { /* not ours */ }
    }
    const n = page.links && page.links.next;
    next = n ? (n.startsWith("http") ? n : mirror + n) : null;
  }
  return out;
}

function txLink(cfg, tx) {
  if (cfg.network === "hedera:local") return `<a href="${esc(cfg.mirrorUrl)}/api/v1/transactions/${esc(tx)}" target="_blank">${esc(tx)}</a>`;
  const [acct, ts] = tx.split("@");
  const [s, n] = (ts || "").split(".");
  const id = ts ? `${acct}-${s}-${(n || "0").padStart(9, "0")}` : tx;
  return `<a href="https://hashscan.io/${cfg.network.replace("hedera:", "")}/transaction/${esc(id)}" target="_blank">${esc(tx)}</a>`;
}
const time = (ts) => new Date(Number(ts.split(".")[0]) * 1000).toLocaleString();

async function main() {
  const cfg = await (await fetch("/config.json")).json();
  if (!cfg.spentTopic || !cfg.ledgerTopic) {
    const s = (await (await fetch(`${cfg.facilitator}/supported`)).json()).hexera;
    cfg.spentTopic ??= s.topics.spent;
    cfg.ledgerTopic ??= s.topics.ledger;
  }
  $("src").innerHTML = `mirror ${esc(cfg.mirrorUrl)} · hexera-spent <span class="mono">${esc(cfg.spentTopic)}</span> · hexera-ledger <span class="mono">${esc(cfg.ledgerTopic)}</span>`;

  const [spent, ledger] = await Promise.all([messages(cfg.mirrorUrl, cfg.spentTopic), messages(cfg.mirrorUrl, cfg.ledgerTopic)]);
  const by = (t) => ledger.filter((m) => m.d.t === t);
  const deposits = by("deposit"), issued = by("issued"), payouts = by("payout"), keys = by("epoch_key");

  const depositedBase = deposits.reduce((a, m) => a + BigInt(m.d.amountBase), 0n);
  const credited = deposits.reduce((a, m) => a + m.d.unitsCredited, 0);
  const issuedDeposit = issued.filter((m) => m.d.reason === "deposit").reduce((a, m) => a + m.d.units, 0);
  const issuedExchange = issued.filter((m) => m.d.reason === "exchange").reduce((a, m) => a + m.d.units, 0);

  // Double-spend scan: the first consensus timestamp wins; later copies are invalid.
  const seen = new Map();
  let dupes = 0;
  const perMerchant = {};
  let spentUnits = 0, exchanged = 0;
  for (const m of spent) {
    if (m.d.t !== "spent") continue;
    let valid = 0;
    for (const id of m.d.spentIds) {
      if (seen.has(id)) dupes++;
      else { seen.set(id, m.seq); valid++; }
    }
    if (m.d.merchant === "hexera:exchange") exchanged += valid;
    else {
      spentUnits += valid;
      (perMerchant[m.d.merchant] ??= { burned: 0, paid: 0, account: "" }).burned += valid;
    }
  }
  let paidUnits = 0;
  for (const p of payouts) for (const x of p.d.merchants) {
    (perMerchant[x.merchant] ??= { burned: 0, paid: 0, account: "" }).paid += x.units;
    perMerchant[x.merchant].account = x.account;
    paidUnits += x.units;
  }

  const card = (n, l) => `<div class="card"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  $("cards").innerHTML = [
    card(usdc(depositedBase), `USDC deposited (${deposits.length} deposits)`),
    card(credited, "voucher units credited"),
    card(issuedDeposit + issuedExchange, `units issued (${issuedExchange} via epoch exchange)`),
    card(spentUnits, "units spent at merchants"),
    card(paidUnits, `units paid out (${payouts.length} batches)`),
    card(spentUnits - paidUnits, "units awaiting payout"),
  ].join("");

  const chk = (ok, text) => `<div class="${ok ? "ok" : "err"}">${ok ? "✔" : "✘"} ${text}</div>`;
  $("checks").innerHTML = [
    chk(issuedDeposit <= credited, `issued ≤ credited: ${issuedDeposit} ≤ ${credited} (no unbacked vouchers)`),
    chk(spentUnits + exchanged <= issuedDeposit + issuedExchange || issued.length === 0,
      `spent + exchanged ≤ issued: ${spentUnits + exchanged} ≤ ${issuedDeposit + issuedExchange}${issued.length === 0 ? " (issuance counts are published with the next payout)" : ""}`),
    chk(paidUnits <= spentUnits, `paid ≤ spent: ${paidUnits} ≤ ${spentUnits}`),
    chk(dupes === 0, `double spends on hexera-spent: ${dupes} (earliest consensus timestamp wins)`),
  ].join("");

  $("merchants").innerHTML = `<tr><th>merchant</th><th>account</th><th>burned</th><th>paid</th><th>pending</th></tr>` +
    Object.entries(perMerchant).map(([id, m]) => `<tr><td>${esc(id)}</td><td class="mono">${esc(m.account || "—")}</td><td>${m.burned}</td><td>${m.paid}</td><td>${m.burned - m.paid}</td></tr>`).join("");

  $("keys").innerHTML = `<tr><th>epoch</th><th>fingerprint</th><th>valid</th><th>published</th></tr>` +
    keys.map((k) => `<tr><td>${k.d.epoch}</td><td class="mono">${esc(k.d.fingerprint)}</td><td>${esc(k.d.validFrom.slice(0, 16))} → ${esc(k.d.validTo.slice(0, 16))}</td><td>${time(k.ts)} (seq ${k.seq})</td></tr>`).join("");

  $("payouts").innerHTML = `<tr><th>batch</th><th>when</th><th>merchants</th><th>units</th><th>HTS transaction</th></tr>` +
    payouts.slice().reverse().map((p) => `<tr><td class="mono">${esc(p.d.batchId)}</td><td>${time(p.ts)}</td><td>${p.d.merchants.map((x) => `${esc(x.merchant)}: ${x.units}`).join("<br>")}</td><td>${p.d.totalUnits}</td><td class="mono">${txLink(cfg, p.d.transactionId)}</td></tr>`).join("");

  $("spent").innerHTML = `<tr><th>seq</th><th>consensus time</th><th>merchant</th><th>units</th><th>spend ids</th><th>request hash</th></tr>` +
    spent.slice(-25).reverse().map((m) => `<tr><td>${m.seq}</td><td>${time(m.ts)}</td><td>${esc(m.d.merchant)}</td><td>${m.d.units}</td><td class="mono">${m.d.spentIds.map((x) => esc(x.slice(0, 16)) + "…").join("<br>")}</td><td class="mono">${esc(String(m.d.requestHash).slice(0, 16))}…</td></tr>`).join("");
}

main().catch((e) => { document.querySelector("main").insertAdjacentHTML("beforeend", `<p class="err">${esc(e.message)}</p>`); });
setInterval(() => main().catch(() => {}), 10000);
