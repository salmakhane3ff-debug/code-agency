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
| Network tree node (Phase 4) | `toRecruiterNetworkNodeView` | id, username, name, level, account status, identity STATUS, children / descendants counts, order COUNTS (real and fake separate) |
| Breadcrumb (Phase 4) | `toRecruiterNetworkPathView` | id, username, name, level |
| Network statistics (Phase 4) | `toRecruiterNetworkStatsView` | totals, per-level counts, identity status counts, order counts (real and fake separate) |

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

## 5. Phase 4 — network tree and statistics (read-only)

`GET /api/recruiter/network/nodes?parentId=&cursor=&limit=&view=unplaced` and `GET /api/recruiter/network/stats?rootId=`
(both `withRecruiterAuth`, account re-checked as active, 120 requests / minute per recruiter and IP).
Service: `src/lib/services/recruiterNetworkService.js`. Nothing in Phase 4 writes anything.

- **Network = ownership.** Only affiliates linked to the recruiter (`recruiter_affiliate_links`) are part of it; the
  hierarchy is the existing `affiliates.parentId`, unlimited depth. A linked affiliate whose parent is empty or not
  linked to the same recruiter is a network root (level 1). An unlinked affiliate (e.g. created by an admin under a
  network member) is never shown or counted. Any `parentId` / `rootId` outside the network → `404 NOT_FOUND`.
- **One recursive query.** One `WITH RECURSIVE` query walks the network from its roots (index on `parentId`, links
  primary key); everything else is batched by 5000 ids (orders `groupBy`, identity status `findMany`, names of the
  page only): the number of queries does not grow with the depth or the number of nodes on a page (no N+1).
- **Malformed data.** Each affiliate has one `parentId`, so a walk from the roots can never loop; the depth is also
  capped by the network size. Members no root reaches (a parent cycle) are counted as `unplaced` and listed separately
  (`view=unplaced`), never placed in the tree.
- **Orders.** Counts only, by bucket of the existing `AffiliateOrder.status`: delivered (exactly `delivered`, the
  reward rule; any other spelling is `other`), pending, confirmed, shipped,
  cancelled (`cancelled` / `canceled`), returned (`returned` / `refused`), other. Real (`isFake = false`) and fake
  (`isFake = true`) are ALWAYS reported separately; a fake order is never a real delivered sale. No customer name,
  phone, address, amount or any order field is returned. The order lifecycle is unchanged.
- **Identity.** The status only (APPROVED / PENDING / REJECTED / NONE when no row); never a document or file key.
- **Statistics.** Totals (affiliates, direct, active / inactive, deepest level, unplaced), identity counts, orders
  real / fake by bucket, and the same per level; per affiliate on the tree nodes. `rootId` scopes them to one
  sub-network (levels relative to it: 1 = its direct affiliates).
- **Not in Phase 4:** rewards payout / withdrawal, reward rule changes, affiliate creation or re-parenting.

## 6. Phase 5 — rewards and withdrawals

### Rewards (`src/lib/services/recruiterRewardService.js`)

- **Settings:** only `recruiter_settings_versions` (append-only, consecutive). The admin sets `enabled`,
  `rewardAmountMad` (stored as cents) and `minDeliveredSales` (1–100000), validated server-side by
  `validateRecruiterSettingsInput`. With no version: OFF, 0 MAD, 10 orders. `RECRUITER_SETTINGS_CHANGED` is audited.
- **Rule:** exactly section 2: real delivered orders (`status === 'delivered'` AND `isFake === false`, actual
  `affiliate_orders` rows) ≥ the threshold AND `IdentityVerification.status === 'APPROVED'`. `isActive` and UGC are
  never read.
- **Immediate award:** post-commit hooks (`src/lib/recruiterRewardHooks.js`, never throw) after an admin sets an
  order to `delivered` (`PUT /api/admin/affiliate-orders`) or approves an identity (`PUT /api/admin/identity`).
  Reconcile passes (batched) run on the recruiter wallet read, after every settings change, and from the admin
  "recheck" action, so a missed event is caught.
- **Ledger:** one `RECRUIT_REWARD` per affiliate (`recruit:<affiliateId>` + partial unique index): concurrent
  events cannot duplicate it. Amount, version and reason are recorded on the row; later settings never change an
  earned reward. Nothing revokes a reward automatically (a reversal needs an explicit admin action, out of scope).
  `RECRUIT_REWARD_EARNED` is audited with the real delivered count and the threshold.

### Withdrawals — the existing workflow, extended (`src/lib/services/recruiterWalletService.js`)

Decision (approved): ONE payout system. Recruiter withdrawals are rows of the existing `affiliate_payouts` table.

- **Migration `20261106_recruiter_rewards_withdrawals`** (additive):
  - `affiliate_payouts.affiliateId` becomes nullable;
  - new `recruiterId` (FK `recruiters`);
  - CHECK exactly one owner;
  - CHECK a recruiter row is a positive whole-cent amount ≤ 1,000,000 MAD;
  - `recruiters.bankName / rib / accountName`.
- **Affiliate rows and affiliate code are unchanged.** Every affiliate balance query filters `affiliateId`, so
  recruiter rows (affiliateId NULL) never enter an affiliate balance.
- **Same rules:** `validateBankInfo` (bank name, holder, RIB 10–34) before any request, and the same reservation
  rule `PAYOUT_RELEASING_STATUSES` (rejected / cancelled release; pending, paid and any other status reserve).
- **Recruiter accounting (MAD cents), never affiliate money:**
  - `earned = Σ recruiter_reward_ledger`;
  - `reserved = Σ their non-released withdrawals`;
  - `available = earned − reserved`;
  - `pending = reserved − paid`.
- **A request** (`POST /api/recruiter/wallet/withdrawals { amountMad, requestId }`) runs in one transaction that
  first locks the recruiter row (`FOR NO KEY UPDATE`), re-checks the account, replays the same `requestId`,
  re-checks bank details and available funds, then inserts a `pending` row. Concurrent requests are serialised, so
  the same funds are never reserved twice.
- **Admin:**
  - the SAME page and API (`/admin/affiliate-payouts`, `GET/PUT /api/admin/affiliate-payouts`) list recruiter rows
    (`ownerType: 'recruiter'`, name and bank) and process them with the same "approve & mark paid" action, plus
    "reject" for recruiter rows only;
  - both change a `pending` row only (conditional write) and are audited (`RECRUITER_WITHDRAWAL_PAID / _REJECTED`);
  - affiliate rows keep the exact previous PUT path; `action: 'reject'` on an affiliate row is refused (400) instead
    of being silently treated as an approval;
  - settings, ledger and balances live in `/admin/recruiter-rewards` (`/api/admin/recruiter-rewards[/settings]`).

### Contract update for money files

Phases 1–4 forbade any money word in recruiter files. Phase 5 money files are an explicit allowlist:

- `recruiterWalletService.js`, `recruiterWalletRouteHandlers.js`, `recruiterRewardAdminHandlers.js`,
  `src/app/api/recruiter/wallet/**`, `src/app/recruiter/wallet/**`.

In them, "withdraw / payout / balance / earning" may appear, but:

- affiliate money sources stay forbidden everywhere: commissions, reward points, affiliate balance functions,
  balance providers;
- every `affiliatePayout` query is scoped by `recruiterId`;
- `affiliateId` is never written to a payout row.

Every other recruiter file keeps the Phase 1 rule unchanged.

## 7. Phase 6 part 1 — affiliate activation codes

The recruiter no longer chooses an affiliate's password. Service: `src/lib/services/affiliateActivationService.js`.

- **Creation** (`POST /api/recruiter/affiliates`): the body has no `password` (sending one → `INVALID_INPUT`).
  - The affiliate is created inactive with an **unusable random password** (a bcrypt hash of 32 random bytes that
    nobody knows).
  - A one-time activation code is issued in the same transaction as the affiliate, its link and the audit row.
  - The code is returned **once**, in the 201 response. An idempotent replay returns `activation: null`.
- **Code:** `<selector>.<verifier>`.
  - selector = 12 random bytes (16 base64url characters, a non-secret lookup key);
  - verifier = 32 random bytes (**256 bits**);
  - only `selector` and `SHA-256(verifier)` are stored (`affiliate_activation_codes`), never the code;
  - the code is never written to logs, audit details, errors or later responses.
- **Rules:**
  - valid 24 h, single use, 5 failed attempts (then invalidated), at most one active code per affiliate
    (partial unique index);
  - a new code invalidates the previous one;
  - rows are never deleted, and only the life-cycle columns may change, forwards only (trigger).
- **Redemption** (`POST /api/affiliate-activation { code, password, passwordConfirm }`, public page `/affiliate/activate`):
  - **Password:** 8–128 characters with a letter and a digit, hashed with the existing bcrypt `hashPassword`.
  - **Locking:** an advisory lock per affiliate, plus a conditional single-use write; concurrent redemptions give
    exactly one success.
  - **One answer for every code problem:** unknown, wrong, expired, used, invalidated or stale codes all get
    `INVALID_OR_EXPIRED_CODE`, so there is no enumeration.
  - **Rate limits:** by IP, and by code selector.
  - **No activation:** it **never activates the account and creates no session**. The existing admin approval
    (`isActive`) and the identity rules are unchanged; login stays refused until the admin activates the
    affiliate.
- **No password reset through this flow:** each code stores a fingerprint (SHA-256) of the password hash it was
  issued for. A code is stale as soon as the password changed in any other way. A new code
  (`POST /api/recruiter/affiliates/<id>/activation-code`, own affiliates only) can be issued only while the
  credentials were never set. A recruiter therefore cannot reset an affiliate's password after the affiliate
  (or an admin) set it.
- **Pending list:** `GET /api/recruiter/affiliates/activation` lists the recruiter's affiliates whose credentials
  are pending (code state only).

**Security limitation (by design, not hidden).** The activation code is a **bearer secret that the recruiter
sees** and shares manually (WhatsApp or another channel):

- This flow guarantees that the recruiter never **chooses or learns** the password the affiliate sets.
- It **cannot prove that the intended affiliate redeemed the code first**: a malicious recruiter could redeem it
  before handing it over, and would then know that password.
- The affiliate would notice, because the code would already be used, and could ask for help; recovery needs an
  admin action (not part of this phase).
- Mitigations in place: the code is shown once and expires after 24 h; the redemption is audited
  (`AFFILIATE_CREDENTIALS_SET`); the account stays inactive until the admin approves it.
- Closing this gap needs a channel the recruiter does not control (SMS/OTP to the affiliate's phone, or an admin
  hand-over). That was not approved for this phase.

Existing accounts are unchanged:

- no password is reset;
- admin-created affiliates and their flow are untouched;
- affiliates created by recruiters BEFORE this phase keep their passwords and have no code, so no code can be
  issued for them.

### Admin activation recovery (Phase 6 part 1)

This is for an affiliate whose activation code was used before them (the bearer-code limitation above).
Service: `src/lib/services/affiliateActivationRecoveryService.js`; migration `20261108_affiliate_activation_recovery`.

1. **The affiliate reports it** on `/affiliate/activate/recovery`, through the public
   `POST /api/affiliate-activation/recovery { identifier, message, contactPhone? }`.
   - The answer is **always `202 { ok: true }`** for a well-formed request: whether the account exists, is
     eligible or already has a request is never revealed.
   - Rate-limited by IP and by identifier.
   - A request is recorded only for an **inactive** affiliate created through the activation-code flow.
   - There is one PENDING request per affiliate (partial unique index); duplicates are absorbed.
2. **The admin reviews it** on `/admin/activation-recovery` (`withAdminAuth`).
   - The list and detail show the affiliate, its recruiter, its identity status, its code history (**states
     only — never a code, selector or hash**) and the audit trail.
3. **Approval** (`POST /api/admin/activation-recovery/<id> { action: 'approve', note? }`), in one transaction under
   the activation advisory lock:
   - The affiliate must still be **inactive**; an active account is never reset through this workflow
     (`AFFILIATE_ACTIVE`).
   - Its password is replaced by an unusable random one, so whoever redeemed the hijacked code is locked out.
   - Every active code is invalidated (`ADMIN_RECOVERY`), and a fresh **ADMIN** code is issued (hash only, 24 h,
     single use, 5 attempts).
   - The request becomes APPROVED through a conditional write, so concurrent approvals give exactly one.
   - The new code is returned **once, to that admin only**, who hands it to the affiliate directly.
   - **Rejection** closes the request and changes nothing else.
4. **The affiliate sets a password** on the existing `/affiliate/activate` page.
   - The account stays inactive until the existing admin approval; the identity rules are unchanged.

**Recruiters can never see or intercept a recovery code:**

- No recruiter endpoint returns a code.
- An ADMIN code in the history blocks recruiter regeneration (`ACTIVATION_NOT_AVAILABLE`) and removes the
  affiliate from the recruiter's pending list.
- The recovery audit rows carry no `recruiterId`.

**Audit** (`recruiter_audit_log`, entity = the affiliate):

- `ACTIVATION_RECOVERY_REQUESTED` (SYSTEM / PUBLIC_FORM);
- `ACTIVATION_RECOVERY_APPROVED` / `_REJECTED` (ADMIN, with the note);
- the request row itself keeps the message, the contact phone, the reported request IP, `requestedAt`,
  `reviewedBy`, `reviewedAt`, the review note and the issued code's id.

**Limitations:**

- The public requester cannot be authenticated: the admin must verify the person (for example by calling the
  affiliate's known phone) before approving.
- The recorded IP comes from proxy headers and can be spoofed if the origin is reachable directly.
- The admin-to-affiliate hand-over is manual, so the new code is again a bearer secret, now held by the admin.
