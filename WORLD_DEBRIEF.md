# World IDKit integration debrief

> **Status:** draft. The notes below come from wiring IDKit v4 (`@worldcoin/idkit` / `@worldcoin/idkit-core` 4.6.0) into Hexera.
>
> The end-to-end flow has been tested with the **dev simulator** (`WORLD_ID_MODE=dev`). It has **not** yet been tested with a real World App proof against the Developer Portal.
>
> Before you submit, fill in every **⟨FILL IN⟩** below after the real World App run.

## What Hexera uses World ID for

**The trust moment.** Hexera pays per request with anonymous vouchers. Without a limit, it could launder money: deposit from many fresh accounts and drain the funds to a colluding merchant. Hedera accounts are free to create, so a cap per account means nothing. The cap has to be per **human**.

**Why Proof of Human, and nothing more.** The cap only needs to know "this is one unique human". It doesn't need age, nationality, documents or a face match, so Proof of Human is the minimum that does the job. Its per-app, per-action nullifier reveals nothing else. Hexera stores only `sha256(nullifier)`, next to the deposit the facilitator already knows about. The nullifier never touches payments, and World ID learns nothing about them.

**The flow.**

- Deposits up to `FREE_DAILY_LIMIT_BASE` per account per day need no proof.
- Above that, the user verifies in the reader's wallet panel with `IDKitRequestWidget` and the `proofOfHuman` preset, with `allow_legacy_proofs: false`. The proof's `signal` is the depositing Hedera account id.
- The facilitator checks the proof on the server. It accepts only `protocol_version` "4.0" from the `production` environment with our action. It checks the `proof_of_human` item's `signal_hash` against `hashSignal(account)`, then verifies with the Developer Portal (`POST /api/v4/verify/{rp_id}`, which must return `success: true`).
- It then reads the per-human id from `result.responses[i].nullifier` and applies the cap: `HUMAN_DAILY_CAP_BASE` per human per day, across every account that human uses.
- **Success path:** Account A verifies and deposits $15, and gets vouchers.
- **Alternative path:** Account B, a second account belonging to the same human, verifies and tries to deposit $10. It is refused: "per-human daily cap reached: 15 of 20 USDC used today". If the money was already sent, it is refunded to that account in the next payout batch.

Code: `packages/facilitator/src/worldid.ts`, `apps/reader/app/WorldIdButton.tsx`.

## Time to first success

- With the dev simulator: **⟨FILL IN: minutes from `npm install` to a capped deposit⟩**
- With a real World App proof: **⟨FILL IN: minutes from creating the Developer Portal app to the first verified deposit⟩**
- Date and place of the real run: **⟨FILL IN⟩**

### Real World App run: checklist

- [ ] **⟨FILL IN⟩** The facilitator log shows `world id: verified proof_of_human (v4); human id read from result.responses[N].nullifier`, which confirms the field.
- [ ] **⟨FILL IN⟩** Account A deposits above the free limit and gets vouchers.
- [ ] **⟨FILL IN⟩** Account B, same human, is refused with "per-human daily cap reached".
- [ ] **⟨FILL IN⟩** Anything the real response did differently from the types (field names, `environment`, `signal_hash` format).

## Friction we hit

1. **v4 needs a server-signed `rp_context` before the widget can open.** That means a backend round trip (`signRequest` from `@worldcoin/idkit-core/signing`) and an RP signing key before you can show a button. It's right for security, but it's the biggest change from v2 and v3, where the widget alone was enough to start.
2. **The README and the types disagree on field names.** The core README builds `rp_context` from `sig.created_at` / `sig.expires_at`, but the `RpSignature` type exposes `createdAt` / `expiresAt`. TypeScript caught it (`TS2551`); plain JS would have sent `undefined`.
3. **Where is the nullifier in a v4 result?** `IDKitResult` is a union (`IDKitResultV3 | IDKitResultV4 | IDKitResultSession`). The README says to forward the result to `/api/v4/verify/{rp_id}`, but it doesn't say where the stable per-human nullifier is, and that nullifier is the one thing a sybil-resistant cap needs. Our first version searched the response for any `nullifier` field. We later found the answer only in the bundled `.d.ts`: `ResponseItemV4.nullifier`, "RP-scoped nullifier (decimal)", inside `result.responses[]`. Hexera now reads only that field.
4. **v3 and v4 nullifiers differ for the same human.** This is documented only in a comment on `allow_legacy_proofs` ("You must track both v3 and v4 nullifiers to prevent double-claims"). For a per-human cap, accepting legacy proofs would let one person hold two caps. We switched from `orbLegacy` to `proofOfHuman` with `allow_legacy_proofs: false`. The naming makes this easy to miss: `orbLegacy` is the README's first example.
5. **Signal binding is left to the integrator.** The result carries `signal_hash`, but nothing in the documented flow compares it with the expected signal. We compare it ourselves with `hashSignal(account)` from `@worldcoin/idkit-core/hashing`.
6. **No local simulator story in the README.** Building a cap needs repeatable "same human, second account" tests. We wrote our own dev mode for that.

## Missing docs

- A page on "using Proof of Human as a rate limit or cap": which field to key on, how stable it is across sessions and devices, and whether it rotates.
- A full Node/Express example of verifying a v4 result on the server, with a sample response body.

## The one biggest improvement

**Document the nullifier, and return it from verify.** Put `responses[].nullifier` in the README, and note that v3 and v4 nullifiers differ. Ideally the verify endpoint would return a typed `{ success, nullifier, action, signal_hash, environment }`, checked against the expected signal. Then sybil-resistant caps, the main use of Proof of Human outside login, would be a five-line integration.
