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
const ICON = {
  check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  alert: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
};
const table = (head, rows, empty) =>
  `<thead><tr>${head.map(([h, cls]) => `<th${cls ? ` class="${cls}"` : ""}>${h}</th>`).join("")}</tr></thead>` +
  `<tbody>${rows.length ? rows.join("") : `<tr><td class="empty" colspan="${head.length}">${empty}</td></tr>`}</tbody>`;

async function main() {
  const cfg = await (await fetch("/config.json")).json();
  if (!cfg.spentTopic || !cfg.ledgerTopic) {
    const s = (await (await fetch(`${cfg.facilitator}/supported`)).json()).hexera;
    cfg.spentTopic ??= s.topics.spent;
    cfg.ledgerTopic ??= s.topics.ledger;
  }
  $("net").innerHTML = `<span class="dot"></span>${esc(cfg.network)}`;
  if (cfg.readerUrl) $("reader").href = cfg.readerUrl;
  $("src").innerHTML = [
    `<span class="badge badge-outline">mirror <span class="mono">${esc(cfg.mirrorUrl.replace(/^https?:\/\//, ""))}</span></span>`,
    `<span class="badge badge-outline">hexera-spent <span class="mono">${esc(cfg.spentTopic)}</span></span>`,
    `<span class="badge badge-outline">hexera-ledger <span class="mono">${esc(cfg.ledgerTopic)}</span></span>`,
  ].join("");

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

  const stat = (n, l, sub) => `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${n}</div><div class="stat-sub">${sub}</div></div>`;
  $("cards").innerHTML = [
    stat(usdc(depositedBase), "Deposited", `USDC · ${deposits.length} deposits`),
    stat(credited.toLocaleString(), "Credited", "voucher units"),
    stat((issuedDeposit + issuedExchange).toLocaleString(), "Issued", `${issuedExchange} via epoch exchange`),
    stat(spentUnits.toLocaleString(), "Spent", "units at merchants"),
    stat(paidUnits.toLocaleString(), "Paid out", `${payouts.length} HTS batches`),
    stat((spentUnits - paidUnits).toLocaleString(), "Pending", "awaiting payout"),
  ].join("");

  const checks = [
    [issuedDeposit <= credited, "No unbacked vouchers", `issued ≤ credited: ${issuedDeposit} ≤ ${credited}`],
    [spentUnits + exchanged <= issuedDeposit + issuedExchange || issued.length === 0, "No spending beyond issuance",
      `spent + exchanged ≤ issued: ${spentUnits + exchanged} ≤ ${issuedDeposit + issuedExchange}${issued.length === 0 ? " (issuance counts are published with the next payout)" : ""}`],
    [paidUnits <= spentUnits, "No payouts beyond spending", `paid ≤ spent: ${paidUnits} ≤ ${spentUnits}`],
    [dupes === 0, "No double spends", `${dupes} duplicate spend ids on hexera-spent; the earliest consensus timestamp wins`],
  ];
  const failed = checks.filter((c) => !c[0]).length;
  $("checks-badge").innerHTML = failed ? `<span class="badge badge-err">${failed} failing</span>` : `<span class="badge badge-solid">All ${checks.length} pass</span>`;
  $("checks").innerHTML = checks
    .map(([ok, t, d]) => `<li class="check${ok ? "" : " fail"}"><span class="tick">${ok ? ICON.check : ICON.x}</span><span><div class="t">${ok ? "" : "Failing: "}${t}</div><div class="d">${d}</div></span></li>`)
    .join("");

  $("merchants").innerHTML = table(
    [["Merchant"], ["Account"], ["Burned", "num"], ["Paid", "num"], ["Pending", "num"]],
    Object.entries(perMerchant).map(([id, m]) => `<tr><td>${esc(id)}</td><td class="mono">${esc(m.account || "—")}</td><td class="num">${m.burned}</td><td class="num">${m.paid}</td><td class="num">${m.burned - m.paid}</td></tr>`),
    "No spends yet",
  );

  $("keys").innerHTML = table(
    [["Epoch"], ["Fingerprint"], ["Valid"]],
    keys.map((k) => `<tr><td>${k.d.epoch}</td><td class="mono" title="${esc(k.d.fingerprint)}">${esc(k.d.fingerprint.slice(0, 16))}…</td><td><div>${esc(k.d.validFrom.slice(0, 10))} → ${esc(k.d.validTo.slice(0, 10))}</div><div class="muted">published ${time(k.ts)} · seq ${k.seq}</div></td></tr>`),
    "No epoch keys published",
  );

  $("payouts").innerHTML = table(
    [["Batch"], ["When"], ["Merchants"], ["Units", "num"], ["HTS transaction"]],
    payouts.slice().reverse().map((p) => `<tr><td class="mono">${esc(p.d.batchId)}</td><td>${time(p.ts)}</td><td>${p.d.merchants.map((x) => `${esc(x.merchant)} <span class="muted">${x.units}</span>`).join("<br>")}</td><td class="num">${p.d.totalUnits}</td><td class="mono">${txLink(cfg, p.d.transactionId)}</td></tr>`),
    "No payouts yet",
  );

  $("spent").innerHTML = table(
    [["Seq"], ["Consensus time"], ["Merchant"], ["Units", "num"], ["Spend ids"], ["Request hash"]],
    spent.slice(-25).reverse().map((m) => `<tr><td>${m.seq}</td><td>${time(m.ts)}</td><td>${esc(m.d.merchant)}</td><td class="num">${m.d.units}</td><td class="mono">${m.d.spentIds.map((x) => esc(x.slice(0, 16)) + "…").join("<br>")}</td><td class="mono">${esc(String(m.d.requestHash).slice(0, 16))}…</td></tr>`),
    "No spent messages yet",
  );
}

main().catch((e) => { document.querySelector(".hero .keylime > div").insertAdjacentHTML("beforeend", `<div class="error" role="alert">${ICON.alert}${esc(e.message)}</div>`); });
setInterval(() => main().catch(() => {}), 10000);
