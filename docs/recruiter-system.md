# Affiliate Recruiter System — rules and binding contracts

Phase 1 (schema, settings, recruiter projections). Later phases must follow every rule below.

## 1. Principal and scope

- Recruiters are a separate principal (`recruiters` table, own login, JWT `type: "recruiter"`).
  They are never a `User` role and never an `Affiliate`. Only an admin creates or disables them.
- A recruiter **creates** affiliate accounts (inactive, pending verification) and links each one
  to the affiliate who brought them (`affiliates.parentId`). Existing affiliates can never be
  assigned to a recruiter (no API path; database guard `recruiter_link_new_affiliate_only`).
- Recruiter rewards live in `recruiter_reward_ledger` only: MAD cents, append-only, one
  `RECRUIT_REWARD` per affiliate (idempotency key + partial unique index). They never touch
  affiliate balances, commissions, reward points, payouts or withdrawals.

## 2. Reward rule

A reward is due — and is **recorded immediately and visible to the recruiter at once** — when the
affiliate created by the recruiter has **both**:

| Condition | Exact source in the existing code |
|---|---|
| Real delivered orders ≥ the admin threshold (default **10**) | `AffiliateOrder.status === 'delivered'` **and** `isFake === false`. Cancelled, pending, confirmed, shipped and fake orders never count. (`affiliates.deliveredOrdersCount` is NOT used: it does not exclude fake orders.) |
| CIN (Carte Nationale) approved | `IdentityVerification.status === 'APPROVED'` — set **only** by an admin (`adminApproveIdentity`, `PUT /api/admin/identity` action `approve`, `withAdminAuth`). A login never approves anything; an affiliate's submission only sets `PENDING`. Same state as `isIdentityApproved()` (withdrawal gate). |

- These are the ONLY two conditions. `affiliates.isActive` (account activation / login flag) is
  **not** a condition: it is never read for the recruiter reward, and if an admin later disables
  the affiliate, an earned reward is **not** cancelled because of `isActive`.
- Fake orders never count. Returns, or a CIN status change after the reward was earned, do not
  reverse anything automatically: they are handled manually by an admin in a later phase.
- The reward amount (MAD) and the order threshold (1–100000, default 10) are set by the admin
  (`recruiter_settings_versions`, append-only versions; with no version: rewards OFF, 10 orders).
- No delay, no jitter, no hidden reward: once recorded, the reward appears in the recruiter's
  rewards and total with its real time.
- **UGC is not part of the recruiter reward.** Recruiter reward code must not read UGC
  submissions, videos, statuses or counts. The UGC system itself is unchanged.

## 3. Binding contract for recruiter-facing code (Phase 2 and later)

Every recruiter-facing endpoint, page payload, statistic and error MUST be built only with
`src/lib/recruiterVisibility.js`:

| Data | Function | Recruiter receives |
|---|---|---|
| Reward status of an affiliate | `toRecruiterQualificationView` | `{ rewardStatus: EARNED \| PENDING \| UNAVAILABLE }` |
| Settings | `toRecruiterSettingsView` | rewards on/off, amount (MAD), required delivered orders |
| Ledger row | `toRecruiterRewardView` | type, amount, affiliate id, time |
| Reward total | `toRecruiterRewardTotals` | sum of their recorded rows |
| Audit entry | `toRecruiterAuditView` | own allowlisted actions only, else `null` |
| Error | `toRecruiterError` | `{ code }` from the allowlist, else `SERVER_ERROR` (INVALID_INPUT may add allowlisted `fields`) |
| Affiliate of their own network (Phase 3) | `toRecruiterNetworkAffiliateView` | id, username, name, parentId (only if in their network), createdAt |

Forbidden in recruiter-facing code: returning raw rows of `recruiter_settings_versions`,
`recruiter_reward_ledger` or `recruiter_audit_log`; reading any UGC table or field for recruiter
rewards; returning CIN documents or file keys (the recruiter may see the verification status
only); returning an affiliate's balance or earnings, or raw affiliate rows; changing an
affiliate's parent or verification status; error messages (codes only). The contract test in
`scripts/recruiterVisibility.test.mjs` scans every recruiter route / handler / service file.

## 4. Phase 3 — a recruiter creates affiliates in their own network

`POST /api/recruiter/affiliates` and `GET /api/recruiter/affiliates?q=` (both `withRecruiterAuth`, account re-checked
as active on every request). Service: `src/lib/services/recruiterAffiliateService.js`.

- **Creation only.** The recruiter creates a NEW affiliate: same account rules as the admin creation (lower-cased
  username, bcrypt password, `isActive = false`, database defaults for every other column); stricter validation
  (username 3–30 with a letter, name 2–80, password 8–128, optional phone, unique username AND phone across both
  columns since the affiliate login accepts either). No admin-only field is accepted (strict body: any other key →
  `INVALID_INPUT`). Only an admin activates the account and approves the CIN.
- **Parent.** None (root) or an affiliate already linked to THIS recruiter. Checked on the server inside the
  transaction, with the whole ancestry verified to be acyclic and inside the same network. Another recruiter's
  affiliate, an unlinked affiliate and an unknown id all answer the same `PARENT_NOT_IN_NETWORK` (no enumeration).
  The new id is generated by the server, so self-parenting is impossible; no code path changes `parentId` after
  creation (no PUT / PATCH / DELETE; no `affiliate.update` in recruiter code).
- **One transaction.** Lock of the recruiter row (`FOR NO KEY UPDATE`: serialises the recruiter's creations and any
  concurrent admin disable) → account re-check → idempotency (`requestId`, a client UUID per submission: the same
  id replays the first result with `200 { replayed: true }`, a different payload → `IDEMPOTENCY_CONFLICT`) →
  parent checks → uniqueness checks → affiliate → `recruiter_affiliate_links` row → `AFFILIATE_CREATED` audit row.
  Any failure rolls everything back.
- **Phase 1 database guard.** `recruiter_link_new_affiliate_only` accepts a link only for an inactive affiliate
  written in the same transaction (≤ 2 minutes old). Its documented limits (an existing affiliate touched or
  re-dated in the linking transaction) are closed in the service: the link's `affiliateId` is always the id the
  service generated for the row it created in that transaction, and recruiter code never updates an affiliate.
  `recruiterAffiliateLink.create` exists only in this service (enforced by a test).
- **Abuse protection.** 20 creations per minute per recruiter and IP (`429 RATE_LIMITED`); no total cap.
- **Not in Phase 3:** the network tree, statistics and rewards UI (Phase 4).
