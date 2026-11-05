# Hexera: private x402 on Hedera

**Pay per request without publishing your reading history.**

Hexera makes x402 payments on Hedera unlinkable. The chain, the facilitator and the merchant can each see that a valid payment happened. None of them can see who paid for what.

It adds a new x402 v2 payment scheme, `hexera-ecash`. Users deposit USDC once, then pay per request with blind-signed vouchers ([RFC 9474](https://www.rfc-editor.org/rfc/rfc9474)). A public HCS topic acts as the double-spend registry, and merchants are paid in batched HTS transfers. There are no smart contracts.

> Standard x402 on Hedera signs a `TransferTransaction` from payer to merchant for every request, so anyone can rebuild a reader's history, a trading desk's data purchases, or a merchant's customer list. Hedera's own x402 docs list "no native privacy" as a limitation. Hexera removes that limitation.

---

## Quick start (no Hedera keys needed)

```bash
npm install
npm test          # 18 tests: crypto, full payment loop, replay / forgery / request-lifting / cap attacks, admin auth, World ID
npm run dev       # facilitator :4020 · publishers :4021 :4022 · reader :3000 · audit :3001
npm run demo      # in a second terminal: the 3-minute demo as a narrated script
```

Open <http://localhost:3000>, deposit, then open some articles. Open <http://localhost:3001> to see the public books.

By default everything runs in **local mode**. The facilitator simulates HCS, HTS and the mirror node in-process. It serves the real mirror-node REST paths (`/api/v1/topics/:id/messages`, `/api/v1/transactions/:id`), so the client and audit page run the same code they run against testnet.

## Running on Hedera testnet

1. Create a funded testnet account at <https://portal.hedera.com> and put it in `.env` as `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY`.
2. `npm run setup:testnet` creates:
   - the treasury account with a **2-of-3 KeyList**
   - a test stablecoin `hUSD` with 6 decimals (skipped if you set `HEXERA_TOKEN_ID`, e.g. testnet USDC)
   - the `hexera-spent` and `hexera-ledger` topics, with a submit key
   - two merchant accounts
   - two funded demo users

   It writes everything to `data/testnet.env`.
3. Merge `data/testnet.env` into `.env` (it sets `HEXERA_MODE=testnet`). Set `ADMIN_TOKEN` to a long random value if you want `POST /payout` and `POST /admin/refund`; without it those endpoints are disabled and only the payout cron runs. Then `npm run dev` and `npm run demo`.
4. The demo prints HashScan links for the deposit, every per-request HCS burn, and the HTS payout batch.

### Settled payment on testnet

From a real `npm run demo` run on Hedera testnet:

- **Deposit (HTS):** <https://hashscan.io/testnet/transaction/0.0.11328934-1793906980-443518233>
- **Per-request burns (HCS `hexera-spent`):** <https://hashscan.io/testnet/topic/0.0.11328930>
- **Payout batch (HTS, 2-of-3 key):** <https://hashscan.io/testnet/transaction/0.0.11328348-1793906999-089751001>
- **Refund of stranded deposits:** <https://hashscan.io/testnet/transaction/0.0.11328348-1793907010-453719398>

The stablecoin is **hUSD**, a test HTS stablecoin (6 decimals) we minted ourselves with `npm run setup:testnet`. It is not Circle's USDC. Token ID `0.0.11328928`. The `hexera-ledger` topic (epoch keys, deposits, issued counts, payout summaries) is `0.0.11328931`, and the treasury account is `0.0.11328926`.

## Architecture

```
            deposit USDC (HTS) once                     payout batch (HTS), every few min
  User ───────────────────────────────▶ Treasury (2-of-3 KeyList) ───────────────────────▶ Merchants
   │                                         ▲
   │ 1 World ID + /deposit/verify            │ facilitator holds deposits
   │ 2 /issue  (blinded serials → blind sigs)│
   ▼                                         │
 Wallet (vouchers in IndexedDB) ──3 GET──▶ Merchant ──402 PAYMENT-REQUIRED──▶ Wallet
   │                                         │
   └──4 retry with PAYMENT-SIGNATURE────────▶│──5 /verify + /settle──▶ Facilitator
                                             │                            │6 burn serial hashes
                                             ◀──200 + PAYMENT-RESPONSE────┘  on HCS hexera-spent
```

| Package | What it is |
|---|---|
| `packages/core` | Voucher types; RFC 9474 blind RSA (`RSABSSA-SHA384-PSS-Randomized`, 2048-bit); `requestHash`; x402 v2 header codec; HCS message types |
| `packages/hedera` | Mirror-node client; testnet backend (Hiero JS SDK: HCS submit, threshold-key HTS payouts); `LocalLedger` simulation |
| `packages/facilitator` | Fastify server: `/deposit/check` `/deposit/verify` `/issue` `/verify` `/settle` `/exchange` `/supported` `/books`, plus token-protected `/payout` and `/admin/refund`; payout cron; SQLite cache |
| `packages/server` | Merchant side: `hexeraPaywall(merchant, { price })` Express middleware, plus a framework-agnostic `HexeraMerchant` |
| `packages/client` | `HexeraWallet`: deposit redemption, blind voucher purchase, a 402-paying `fetch`, IndexedDB/file/memory stores |
| `apps/publisher` | Demo merchant (Express). It runs twice, as "The Daily Ledger" and "Quant Feed" |
| `apps/reader` | Next.js demo: two publishers, paywalled articles, wallet panel, World ID |
| `apps/audit` | One static page that rebuilds the books from the two HCS topics only |
| `scripts/` | `setup-testnet.ts`, `demo-e2e.ts`, `blindrsa-smoke.ts` |

Hedera services used (all through the JS SDK and the mirror node, no Solidity):

| Service | Used for |
|---|---|
| **HTS** | USDC deposits into the treasury; batched payouts. One transfer can pay up to 9 merchants. |
| **HCS `hexera-spent`** | One message per payment, holding the spend ids and request hash. Consensus order settles double-spend races, and each payment gets a Hedera transaction id. |
| **HCS `hexera-ledger`** | Epoch public keys, deposit records, issued-voucher counts, payout batch summaries |
| **Threshold key (KeyList 2/3)** | The treasury. Payouts need 2 of 3 keys. |
| **Mirror Node REST** | Verifying deposits; rebuilding the spent cache; the audit page; clients checking epoch keys |

## Payment flow: the `hexera-ecash` scheme

**Voucher.** One fixed unit, `U = 0.001 USDC` (1,000 base units). It sells for 1,010 base units, and the spread pays HCS and transfer fees. On the wire it looks like `{ "epoch": 20762, "serial": "<hex>", "sig": "<base64>" }`.

`serial` is the RFC 9474 *prepared message*: 32 random bytes from `Prepare()` followed by 32 random bytes from the client. The facilitator never sees it before it is spent. `spendId = sha256(serial)` is what goes on HCS, so about 12 spends fit in one 1 KiB message.

1. **Deposit.** The user sends USDC to the treasury. `POST /deposit/verify {txId, worldId?}` checks the transfer on the mirror node and returns a one-time credit for ⌊amount / 1010⌋ units.
2. **Get vouchers.** The client makes random serials, blinds them and sends `POST /issue {credit, blinded[]}`. It gets back blind signatures, unblinds them, verifies each one, and stores the vouchers locally. The client refuses epoch keys that are not published on `hexera-ledger`.
3. **Request.** The merchant answers `402` with this `PAYMENT-REQUIRED` header:
   ```json
   { "x402Version": 2, "resource": {...},
     "accepts": [{ "scheme": "hexera-ecash", "network": "hedera:testnet", "amount": "3",
                   "asset": "<token id>", "payTo": "daily-ledger", "maxTimeoutSeconds": 60,
                   "extra": { "facilitator": "http://…", "epoch": 20762 } }] }
   ```
4. **Pay.** The client retries with this `PAYMENT-SIGNATURE` header:
   ```json
   { "x402Version": 2, "accepted": {…}, "payload": { "vouchers": [v1, v2, v3], "requestHash": "<hex>" } }
   ```
   `requestHash = sha256(METHOD " " path?query "\n" sha256(body))`. The merchant recomputes it, so a voucher set can't be lifted onto another request.
5. **Verify and settle.** The merchant calls `/verify` and then `/settle`. The facilitator checks signatures, epoch, amount and the spent cache, then reserves the spend ids in one SQLite transaction.
6. **Burn.** The facilitator writes `{ t:"spent", spentIds, requestHash, merchant, units }` to `hexera-spent`. The merchant serves the content with this `PAYMENT-RESPONSE` header:
   ```json
   { "success": true, "network": "hedera:testnet", "transaction": "<HCS tx id>", "spentIds": [...] }
   ```
   There is no `payer` field, on purpose.
7. **Payout.** Every `PAYOUT_INTERVAL_SECONDS`, the facilitator sends one HTS transfer from the treasury to all merchants with pending balances. It also refunds deposits that were refused by the cap, and posts the batch summary to `hexera-ledger`.

**Double-spend rule.** A serial is spent if its spend id appears on `hexera-spent`; the earliest consensus timestamp wins.

Inside one facilitator, the SQLite reservation closes the race before HCS is written. On startup, and every 15 s on testnet, the facilitator syncs the spent topic from the mirror node, so a restart or a second facilitator never accepts a burned serial.

**Epochs.** There is one RSA-2048 key per epoch (24 h by default), and every user gets that same key. Its public key and validity window are published on `hexera-ledger`. Vouchers stay spendable for a grace period after their epoch ends. `POST /exchange` burns old-epoch vouchers and blind-signs the same number of new ones, so value carries over and there is no cash-out.

## CROPS

- **C (censorship resistance):** The facilitator controls who can deposit and get vouchers, and it runs the payout. If it refuses someone, they can't get vouchers. It can't redirect vouchers already issued, and payouts are public. Anyone can run their own facilitator from this repo, and `HexeraMerchant` is configured per facilitator URL.
- **O (open source):** MIT. The facilitator, client, merchant middleware and demo apps all build from this repo alone, and everything public is readable from the mirror node.
- **P (privacy):** The **facilitator** learns who deposited and which merchant redeemed which serials, but not which depositor owns which serial: the signatures are blind. The **merchant** learns that a valid payment arrived, but not the payer's account or deposit. A **chain observer** sees deposits, anonymous serial hashes and payouts, but not who paid whom. **World ID** learns only that a verification happened for the Hexera app, and nothing about payments. IP addresses are **not** hidden.
- **S (security):** Voucher secrets are made and stored only in the user's browser (IndexedDB). Deposits sit behind a 2-of-3 threshold key, and the client refuses epoch keys that aren't on HCS. Trust assumptions: the facilitator holds deposits (bounded by the threshold key, the per-human cap and public books) and keeps its signing key safe. They are listed in full below.

## Trust and threat model

Privacy holds against everyone. Safety of funds relies on the facilitator, limited by a threshold key and public books.

| Party | Learns | Does not learn |
|---|---|---|
| Public chain | Account X deposited $Y to Hexera; merchant M got a payout of $Z; serials were burned at time T | Which depositor paid which merchant, or for which request |
| Facilitator | Who deposited and how much; which merchant redeemed which serials | Which depositor owns which serial |
| Merchant | A valid payment arrived, plus normal HTTP metadata | The payer's account or deposit |
| World ID | That a verification happened for the Hexera app | Anything about payments |

| Attack | Mitigation | Left over |
|---|---|---|
| Spend a voucher twice | HCS spent registry plus an atomic local reservation; the earliest consensus wins | — |
| Reuse a voucher set on a different request | `requestHash` checked by the merchant | — |
| Forge vouchers | RSA-2048 signatures; per-epoch keys | Key theft. In production the signing key belongs in an HSM, off the payout server. |
| Facilitator issues unbacked vouchers | `hexera-ledger` publishes deposits and issued counts; the audit page checks issued ≤ credited | Someone has to look |
| Facilitator runs off with deposits | 2-of-3 threshold key; per-human deposit cap | Trust in the key holders |
| Facilitator skips a merchant's payout | Merchants match their own spends on HCS against payout batches (shown on the audit page) | The merchant has to raise it |
| Facilitator tags users with unique keys | One key per epoch, published on HCS; the client refuses unknown keys | — |
| Timing links a deposit to its first spend | The client adds random spend delays; issued counts are published in batches | Small anonymity set at hackathon scale |
| Amount fingerprinting | Fixed denomination only | — |
| Money laundering | No cash-out to arbitrary accounts (only merchant payouts and refunds to the depositing account); per-human daily cap via World ID | Collusion with a registered merchant |

## Why Proof of Human

The per-human deposit cap needs only **uniqueness**: "this is one human". It doesn't need age, nationality, documents or a face match. Hedera accounts are free to create, so a per-account cap means nothing. Proof of Human is the minimum credential that does the job.

Deposits up to `FREE_DAILY_LIMIT_BASE` per account per day need no proof. Above that, the deposit needs a Proof of Human, whose per-app nullifier caps it at `HUMAN_DAILY_CAP_BASE` per human per day across all of that person's accounts. The proof's signal is the depositing account id, and the server checks it against the proof's `signal_hash`. The facilitator stores only `sha256(nullifier)`.

Only World ID 4.0 proofs from the production environment are accepted. The same human has different v3 and v4 nullifiers, so accepting both would allow two caps. With `WORLD_ID_MODE=production` there is no fallback to the simulator.

## Limitations

- **Local mode is a simulation.** Without testnet keys, the facilitator simulates HCS, HTS and the mirror node in-process. The testnet links above are from the real network.
- **IP addresses are not hidden.** The network layer is out of scope: merchants see client IP addresses, so use Tor or a VPN.
- **Small anonymity set.** Privacy grows with the user base. With one or two demo users, timing analysis is easy.
- **Custodial deposits.** The facilitator holds deposits. They are limited by the threshold key, the per-human cap and public books, but a zk version that removes this trust is future work.
- **Demo deposits are signed server-side.** In the reader app, `/api/deposit` plays the role of the user's wallet: a simulated transfer in local mode, or a key from `.env` on testnet. A production client would have HashPack or WalletConnect sign the same `TransferTransaction`. Vouchers are still blinded and stored only in the browser.
- **The facilitator holds 2 of the 3 treasury keys in the demo.** That's fine for a demo, but in production the second key holder signs payout batches separately. Scheduled transactions are the natural fit, and they aren't implemented yet.
- **Only `hexera-ecash` payments are handled.** `HexeraMerchant` accepts `extraAccepts`, so a server can list the standard Hedera `exact` scheme beside it. `exact` payments are listed but not processed.
- **Strict multi-facilitator ordering.** Two facilitators sharing one spent topic converge through the 15 s mirror sync, not per request. One facilitator per topic is the supported setup.
- **`/admin/refund` exists.** It is an operator endpoint that refunds deposits whose vouchers were never issued, for example when a client lost its credit. It needs `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare), and it is not registered at all when `ADMIN_TOKEN` is unset.
- **Deposits refused by the cap are refunded in the next payout.** A deposit with no proof above the free limit is not recorded, so the user can retry it with a proof. Use `/deposit/check` before sending money, as the reader app does.

## Implementation notes

- **Faster blind RSA.** Blind and Finalize run on native `BigInt`. BlindSign uses OpenSSL raw RSA (`privateDecrypt`, `RSA_NO_PADDING`), with RFC 9474's verify-after-sign check on every signature. OpenSSL blinds the operation, runs CRT with constant-time exponentiation, and recomputes without CRT if the CRT result fails its own check. `blindrsa-ts` alone measured about 30 ms per Blind and about 300 ms per BlindSign. Hexera does about 2 ms each, so a $15 deposit (14,851 vouchers) is blinded in the browser in about 27 s. Tests check the output against `blindrsa-ts` byte for byte, and every unblinded signature is verified with WebCrypto RSA-PSS before it is stored.
- **x402 types and headers.** Types come from `@x402/core`. Headers are base64(JSON), using a Unicode-safe codec that matches the wire format of `@x402/core/http`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts all five services (local mode unless `.env` says testnet) |
| `npm run demo` | Narrated end-to-end demo against the running services |
| `npm test` | Unit and integration tests |
| `npm run typecheck` | TypeScript across the backend packages |
| `npm run setup:testnet` | Creates testnet accounts, token, topics and treasury |
| `npm run smoke:blindrsa` | blind → sign → finalize → verify check, with timings |

## How AI was used

The design document is our own. We used Claude (Anthropic's Claude Code) as a coding assistant to refine the design and to generate most of the code, tests and documentation. We directed the work, reviewed the changes, and ran the system ourselves on Hedera testnet; the transactions above come from that run.

## Docs

- [`docs/Hexera — Private x402 on Hedera.pdf`](docs/) is the original design document.
- [`WORLD_DEBRIEF.md`](WORLD_DEBRIEF.md) is the IDKit integration debrief.

MIT licensed.
