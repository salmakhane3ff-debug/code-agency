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
- Fake orders never count. Cancelled, returned, refused (or any non-`delivered`) orders never count:
  since Phase 6 part 3a, a reward whose real delivered count later falls below the threshold of ITS
  settings version is reversed automatically, once per cycle (section 9). A CIN status change after
  the reward was earned does not reverse anything.
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
- **Immediate award:** post-commit hooks (`src/lib/recruiterRewardHooks.js`, never throw) after **every** admin
  affiliate-order status change (`PUT /api/admin/affiliate-orders`), after the fake-order status sync
  (`orderService.updateOrder` → `onRecruiterLinkedOrderSynced`) and after an affiliate identity approval
  (`PUT /api/admin/identity`). Since Phase 6 part 3a a status change can also reverse a recruiter reward (section 9).
  Reconcile passes (batched) run on the recruiter wallet read, after every settings change, and from the admin
  "recheck" action, so a missed event is caught.
- **Ledger:** rewards are recorded in versioned cycles: at most one `RECRUIT_REWARD` per affiliate and cycle
  (`recruit:<affiliateId>:v<n>`; rows written before the cycles keep `recruit:<affiliateId>` as cycle 1), enforced
  by a partial unique index per (affiliate, cycle), so concurrent events cannot duplicate it. Amount, version and reason are recorded on the row; later settings never change an
  earned reward. Since Phase 6 part 3a a reward is reversed automatically when the real delivered count falls
  below its threshold (section 9); a CIN change never reverses it.
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

## 8. Phase 6 part 2 — account & session security

Decisions D1–D7 (approved). D3 (admin sessions) is out of scope. D5 (per-account login throttling) is
implemented in memory, because production runs **one** Next.js web instance (confirmed by the owner).

### Session revocation — `tokenVersion` (D1, D2)

- **Migration `20261109_account_token_version`:** `affiliates."tokenVersion"` and `recruiters."tokenVersion"`
  (`INTEGER NOT NULL DEFAULT 0`, CHECK `>= 0`). Additive; no table rewrite; no row updated.
- **Tokens:** every affiliate or recruiter token now carries `tv`. A token issued before this change has no `tv`
  and counts as **0**, so nobody is logged out by the deployment; it becomes invalid at the first bump.
- **The version is bumped (+1) on:**
  - disable **and** enable (a re-enabled account never revives an older token);
  - a self-service password change;
  - an admin password reset;
  - a password set through an activation code or an admin recovery.
- **Checked on every request:**
  - **Recruiter:** `requireActiveRecruiter`, already per request; the version is now compared too.
  - **Affiliate:** `withAffiliateAuth` now reads the account on every request (one primary-key read). It must
    exist, be **active**, and have the same version, otherwise `401`. A database error answers `503`.
  - **Behaviour change:** a disabled affiliate loses API access immediately, instead of after up to 7 days.

### Passwords (D4, D7)

- **Recruiter self-service:** `PUT /api/recruiter/password { currentPassword, newPassword, newPasswordConfirm }`.
  - The current password is verified, and the policy is 8–128 characters (as at creation).
  - The write is conditional on the verified hash, so concurrent changes cannot overwrite each other.
  - Every older session is revoked; the caller gets a fresh cookie. Audit: `RECRUITER_PASSWORD_CHANGED`.
- **Admin reset of a recruiter:** `POST /api/admin/recruiters/<id>/password { newPassword }`.
  - Revokes every session and **never changes `isActive`**. Audit: `RECRUITER_PASSWORD_RESET`, without the password.
- **Affiliate self-service** (`PUT /api/affiliate/me`, type `profile`):
  - the current password is verified (unchanged);
  - the server now enforces the existing 6–128 policy, with a rate limit on the trusted IP;
  - every older session is revoked, and the response carries a fresh `token`, which the dashboard stores, plus a
    fresh cookie.
- **Admin edit of an affiliate** (`PUT /api/admin/affiliates`):
  - a password reset (6–128) or a **real** activation change bumps the version;
  - it is audited in `recruiter_audit_log` (`AFFILIATE_PASSWORD_RESET`, `AFFILIATE_ENABLED` / `AFFILIATE_DISABLED`,
    ADMIN actor, no password);
  - re-saving the same activation state changes nothing, and a password reset never changes `isActive` by itself.
- **Affiliate login:** the password is checked **before** the activation state ("Compte inactif" is only said to
  someone who knows the password), and an unknown identifier runs a dummy bcrypt comparison, so there is no
  existence or state enumeration.
- **Never in responses or logs:** no password, hash or reset token.

### Trusted proxy and client IP (D6)

`src/lib/trustedProxy.js` is applied **only** to:

- recruiter login and password change;
- affiliate login and password change;
- activation-code redemption and recovery requests.

Every other limiter of the app still uses `src/lib/rateLimit.js`, which is unchanged.

| `TRUSTED_PROXY_MODE` | Trusted client IP |
|---|---|
| `cloudflare` | `cf-connecting-ip`, **only** if the request carries `x-trusted-proxy-secret` equal to `TRUSTED_PROXY_SECRET` (≥ 32 characters, timing-safe compare). Without a valid secret, nothing is trusted. |
| `proxy` | The **last** `x-forwarded-for` hop (Nginx must append it). If `TRUSTED_PROXY_SECRET` is set, the secret header is required too (recommended if the origin is reachable directly). |
| unset / anything else | Nothing is trusted (fail safe). |

**When no trusted IP exists, these limiters use ONE shared bucket per route** (`untrusted`): the limits stay
strict but are shared by all clients.

**Required deployment configuration** (not applied here; production settings are unchanged):

- **Behind Cloudflare → Nginx → app:**
  - set `TRUSTED_PROXY_MODE=cloudflare` and a random `TRUSTED_PROXY_SECRET` (≥ 32 characters) in the app
    environment;
  - in Nginx: `proxy_set_header X-Trusted-Proxy-Secret "<secret>";`;
  - restrict the origin to Cloudflare IP ranges.
- **Behind Nginx only:**
  - set `TRUSTED_PROXY_MODE=proxy` (plus the secret if the app port is reachable without Nginx);
  - in Nginx: `proxy_set_header X-Forwarded-For $remote_addr;` (overwrite, do not append the client's value) and
    the secret header.
- **Without this configuration:** after deployment, all affiliate and recruiter logins share one IP bucket
  (affiliate login 10 per minute in total). **Configure it before deploying.**

### Per-account login throttling (D5)

Affiliate login (`loginAffiliate`) and recruiter login (`loginRecruiter`) reuse `src/lib/loginThrottle.js` (the
same module as the admin login).

- **Limit:** **5 failed attempts per account per 15-minute fixed window**; it then answers `429` with a generic
  message.
  - affiliate: `{ error: 'Trop de tentatives. Réessayez plus tard.', code: 'RATE_LIMITED' }`;
  - recruiter: `{ code: 'RATE_LIMITED' }`.
- **No permanent lockout:** the window simply expires.
- **Keys:**
  - affiliate: the matched account (so its username and its phone share **one** counter), else the normalized
    identifier;
  - recruiter: the normalized username.
  - An unknown identifier locks exactly like a real account, so a lock reveals nothing.
- **Concurrency:** each attempt is checked **and counted in one synchronous step, before the password comparison**.
  Concurrent attempts in the process can never all pass the check: at most 5 per window are evaluated.
- **Reset:** a correct password clears the counter, including for an inactive or disabled account, whose answer
  stays "inactive" / `RECRUITER_DISABLED`.
- **Independence:** the per-IP limiters of the routes (trusted proxy, D6) are separate and still apply.
- **Limitation:** the counters live in the web process. They are correct for the current single-instance
  deployment, are reset by a restart, and would NOT be shared if several web instances were ever run; that
  would need a database-backed counter.

### Open items

- **D3:** admin sessions (`users`) are not versioned. The Edge middleware cannot read the database.

## 9. Phase 6 part 3a — reward reversal engine (versioned cycles)

The decisions approved after the Part 3 audit: D1 (versioned cycles) and D2 (reverse below the threshold of the
reward's own settings version). D3–D5 (withdrawals and recruiter KYC) belong to Parts 3b and 3c and are not
implemented here.

- **Rule:** an **open** reward (a cycle without a reversal) whose affiliate's **current** real delivered count
  (`status === 'delivered'` AND `isFake === false`) is **below the threshold of that reward's settings version**
  gets ONE compensating `REVERSAL` row.
  - Its amount is the negative of the reward. Reason: `REAL_DELIVERED_BELOW_THRESHOLD`.
  - Any non-`delivered` status no longer counts: cancelled, canceled, returned, refused, pending, shipped,
    `Delivered`, and so on.
  - A threshold raised later never reverses a reward retroactively.
  - A threshold **lowered** later does not protect an open reward either: it is still judged by its own
    version's threshold. If the count falls below that, it is reversed, and a later sync may award a new cycle
    under the current (lower) threshold and amount. One sync only reverses, so the re-award comes from the next
    sync or reconcile run.
  - After a reversal, the affiliate may qualify again (current settings), which opens a **new cycle**.
- **Cycles (migration `20261110_recruiter_reward_cycles`):** `recruiter_reward_ledger.cycle`.
  - Cycle *n* = `RECRUIT_REWARD` (key `recruit:<affiliateId>:v<n>`) and at most one `REVERSAL`
    (key `reverse:<affiliateId>:v<n>`).
  - Every row written before the migration is cycle 1 and keeps its legacy key (`recruit:<id>` / `reverse:<id>`).
  - **Database invariants:**
    - one reward and one reversal per (affiliate, cycle) (partial unique indexes);
    - key format per cycle (CHECK);
    - the trigger `recruiter_reward_cycle_guard`: a reward must be cycle `max+1` with the previous cycle closed;
      a reversal must target the latest open cycle of the same recruiter and cannot exceed it.
  - The ledger stays **append-only**, so an affiliate's net is always 0 or its open reward.
- **One state-based operation:** `syncRecruiterReward(affiliateId)` awards a new cycle, reverses the open one, or
  does nothing.
  - It runs in its own transaction under a **per-affiliate advisory lock** (`recruit:<affiliateId>`, also taken
    by the trigger).
  - It recomputes the real delivered count **inside the lock**, so an award racing a cancellation ends
    consistent, and duplicate or concurrent events never write twice.
- **Triggers:**
  - after **every** admin affiliate-order status change (`PUT /api/admin/affiliate-orders`);
  - after the fake-order status sync (`orderService.updateOrder` → `onRecruiterLinkedOrderSynced`, for real rows
    linked to that order id);
  - after an identity approval;
  - and the reconcile passes. The **reversal pass always runs**, even with new rewards switched off; the award
    pass runs only when rewards are on.
  - A real store order cancelled or returned on the Orders page does NOT change its affiliate order; the admin
    must update the affiliate order.
- **Audit:** `RECRUIT_REWARD_REVERSED` (SYSTEM), with the cycle, the amount, the settings version, the real
  delivered count, the required count and the reason. `RECRUIT_REWARD_EARNED` now also records the cycle.
- **Display:** a reversal is a negative entry with its reason in the recruiter's reward history ("سحب المكافأة…")
  and in the admin ledger ("Annulation automatique…"), with its cycle.
- **Unchanged:** affiliate commissions, points, balances and payouts (`affiliateSystemService.js` is untouched).
  A reversal lowers the recruiter's available amount at once, which may become negative; withdrawals are
  protected against it by Part 3b (section 10).

## 10. Phase 6 part 3b — negative balance & withdrawal protection

- **Authoritative balance:** `earned` is the sum of the recruiter's `recruiter_reward_ledger` rows, reversals
  included; `available = earned − reserved` (every non-released withdrawal). A reversal lowers it at once, so
  `available` can become **negative** (a reward reversed after it was reserved or paid).
- **Request** (`requestRecruiterWithdrawal`): inside one transaction that first locks the recruiter row
  (`FOR NO KEY UPDATE`), the ledger and the withdrawals are re-read and the request is refused with
  `INSUFFICIENT_BALANCE` when `available ≤ 0` or the amount exceeds it. Concurrent requests are serialised by the
  lock: the same funds can never be reserved twice.
- **Payment** (`adminProcessRecruiterPayout`, action `pay`): takes the same lock, re-reads the ledger and refuses
  with `INSUFFICIENT_BALANCE` (409, French text) when `paid + this withdrawal > earned`. A pending withdrawal
  whose reward was reversed in the meantime can therefore never be paid; the admin rejects it, which releases it.
  `reject` is always possible.
- **Reversal versus payment:** both take the per-recruiter advisory lock `recruiter-money:<recruiterId>`
  (`lockRecruiterMoney`) — the reversal just before it writes, the payment before its balance re-check — so a
  payment decision and a reversal are strictly serialised. Lock order (deadlock-free): reversal = affiliate lock →
  money lock; payment = recruiter row (`FOR NO KEY UPDATE`) → money lock.
- **Reversal versus request:** a request does not take the money lock; any interleaving is equivalent to "request
  first, then reversal", which the payment re-check covers. A reversal after a withdrawal was already **paid**
  leaves a negative balance that later rewards offset (no clawback).
- **Messages:** the recruiter sees Arabic texts (amount above the available balance; a negative balance banner
  explaining that rewards were reversed after cancellations / returns); the admin sees the French refusal text
  and a "solde négatif" marker in the balances table.
- **Unchanged:** the withdrawal history (no row rewritten), the append-only ledger, affiliate payouts and
  `affiliateSystemService.js`. No migration.

## 11. Phase 6 part 3c — recruiter identity verification (KYC)

Decisions D1–D6 approved after the Part 3c audit. The affiliate KYC (`identity_verifications`, `identityService.js`,
`/api/affiliate/identity`, `/api/admin/identity`, `/admin/identity`) is **unchanged**.

- **Table `recruiter_identity_verifications`** (migration `20261111_recruiter_identity_verifications`), separate from the
  affiliate table: one row per recruiter (`recruiterId` unique, FK `ON DELETE RESTRICT`); no row = `NOT_SUBMITTED`.
  - `status` `PENDING | APPROVED | REJECTED`; the review columns are tied to it by a CHECK (PENDING: no reviewer;
    APPROVED: reviewer, `reviewedAt`, `approvedAt`; REJECTED: reviewer, `reviewedAt`, a reason of 1–500 characters).
  - `submission` = 1, 2, … (one per upload). File keys must be `<uuid>.jpg` (CHECK), front ≠ back.
  - Guard trigger: the row is never deleted (nor truncated); `id`, `recruiterId`, `createdAt` never change. Only
    transitions: insert → PENDING (submission 1); PENDING → APPROVED / REJECTED and APPROVED → REJECTED (same
    submission, same files); REJECTED → PENDING only as a new upload (submission + 1, two new files). A REJECTED
    submission can never be approved directly (D1); an APPROVED one can be revoked (D2).
- **History:** the append-only `recruiter_audit_log` — `RECRUITER_IDENTITY_SUBMITTED` (actor RECRUITER),
  `RECRUITER_IDENTITY_APPROVED` / `_REJECTED` (actor = the admin's user id), details `{ submission, from, to, reason? }`.
  Never a file key, an image, a password or any file content.
- **Service** `src/lib/services/recruiterIdentityService.js`:
  - Upload (recruiter): both sides required; each ≤ 5 MB with an accepted declared type **and** a matching real
    signature (JPEG / PNG / WEBP magic bytes); then the existing owner-agnostic private storage
    (`identityStorage.js`: sharp re-encode to JPEG, metadata dropped, `<uuid>.jpg`). New files are written first,
    the row changes in one conditional transaction, superseded files are deleted only **after the commit** (the new
    files are deleted instead if the transaction fails) (D3).
  - Admin decision: names the status and submission it saw (`expectedStatus`, `submission`); a stale decision is
    refused (`STALE_DECISION`, 409). Approve only from PENDING; reject from PENDING or APPROVED (revocation).
- **Withdrawal gates** (`recruiterWalletService.js`):
  - Request: KYC must be `APPROVED`, read inside the request transaction under the recruiter row lock →
    `RECRUITER_IDENTITY_NOT_APPROVED` (HTTP 403) otherwise (D6).
  - Payment: KYC must be `APPROVED` **at payment time**, read after the money lock → refused with
    `RECRUITER_IDENTITY_NOT_APPROVED` (HTTP 409, French text). This also covers withdrawals requested before the KYC
    existed. Reject never checks the KYC: a pending withdrawal can always be rejected (funds released); pending
    withdrawals are never auto-rejected (D4).
  - An admin KYC decision takes the per-recruiter money lock `recruiter-money:<recruiterId>`: a payment and a
    rejection / revocation are strictly serialised. Lock order (no cycle): decision = money lock → KYC row;
    payment = recruiter row → money lock (KYC read only); request = recruiter row (KYC read only); upload = KYC row
    only; reversal = affiliate lock → money lock. Part 3b balance protection is unchanged.
  - Recruiter rewards never read this table: a rejected KYC never stops reward accrual.
- **APIs:** recruiter `GET/POST /api/recruiter/identity` (session recruiter only; multipart body capped at
  2 × 5 MB + 64 KiB while streaming; 5 uploads / 15 min; response = status, reason when REJECTED, dates,
  `canSubmit` — never a file key, path, reviewer or image). Admin `GET/PUT /api/admin/recruiter-identity` and
  `GET /api/admin/recruiter-identity/[id]/[front|back]` (`withAdminAuth`; image `no-store, private`, `nosniff`,
  `image/jpeg`, inline).
- **UI:** recruiter `/recruiter/verification` (Arabic, RTL: status, reason, front / back upload, resubmission) and a
  KYC banner + link on `/recruiter/wallet` (the API stays authoritative). Admin `/admin/recruiter-identity` (queue by
  status, CIN preview fetched into a revoked blob URL, approve / reject with reason, history) + sidebar link.
- **Deployment:** apply migration `20261111_recruiter_identity_verifications` (after `20261110`). CIN files share the
  affiliate private directory `private_uploads/identity` on the app server's disk: it must be persistent, private,
  backed up and shared if several instances run. Recruiters cannot withdraw until an admin approves their KYC —
  announce the requirement before deploying.

## 12. Phase 6 part 4 — recruiter permissions (`canViewOrders`, `canCreateAffiliates`)

Decisions D1–D6 approved after the Part 4 audit. The two columns already existed on `recruiters`
(`NOT NULL DEFAULT true`, migration `20261105`); **no migration** in this part.

- **Admin control** (`PATCH /api/admin/recruiters/[id]/permissions`, `withAdminAuth`, `adminSetRecruiterPermissions`):
  - Body `{ canViewOrders?: boolean, canCreateAffiliates?: boolean }` — at least one field, booleans only, no other field
    (`INVALID_INPUT` otherwise). Each permission is independent.
  - One transaction: the recruiter row is locked (`FOR NO KEY UPDATE` — the same lock an affiliate creation or an
    activation-code regeneration takes, so a change is serialised with them), the flags are re-read, only the fields that
    actually change are written, and **one** append-only audit row is written per changed permission:
    `RECRUITER_PERMISSION_CHANGED`, actor ADMIN (the admin's user id), `recruiterId` / `entityId` = the recruiter,
    `details: { permission, from, to }`, `createdAt`. A no-op writes nothing. Never a password, token or other data.
  - No session bump (D4): permissions are re-read on every recruiter request (`requireActiveRecruiter`), so a change
    applies on the next request.
  - Creation (D5): `POST /api/admin/recruiters` accepts optional `canViewOrders` / `canCreateAffiliates` booleans
    (omitted = `true`); `RECRUITER_CREATED` records both.
  - `/admin/recruiters`: both permissions shown on every card as independent toggles (with confirmation), and two
    checkboxes (on by default) in the creation form.
- **`canViewOrders`** (D1, D2): enforced in the network handlers (`/api/recruiter/network/stats` and `/nodes`, every
  `rootId`, `parentId`, cursor and `view`): when off, **no order query runs** and every `orders` (scope totals, levels,
  nodes) is `null` — never zero-filled counts. The tree, member data, identity counts and the reward history (it explains
  money, no order counts) stay available. No other recruiter route returns order counts. The recruiter dashboard and
  network pages hide the order entries, cards, sections and columns and explain that the admin turned them off.
- **`canCreateAffiliates`** (D3): enforced in the services, under the recruiter row lock — affiliate creation
  (`recruiterCreateAffiliate`, unchanged) and activation-code regeneration (`regenerateActivationCode`, new) both refuse
  with `FORBIDDEN` (403). Pending affiliates stay listed; the admin recovery path stays available for them. The dashboard
  hides "add affiliate", the creation page and the activation page explain the restriction.
- **`/api/recruiter/me`** returns `permissions: { canViewOrders, canCreateAffiliates }` next to the profile, for the UI
  only (the server enforces).
- **Known limitation (D6, outside Part 4):** `canViewOrders` only governs what the **recruiter** account can see. A
  recruiter receives each affiliate's one-time activation code; if they redeem it themselves and the admin later activates
  that affiliate account, they could log in **as the affiliate** and see that affiliate's own orders through the affiliate
  routes. `canViewOrders` does not prevent that; activation-code security is not redesigned in this part.
