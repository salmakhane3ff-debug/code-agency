# 🎭 Fake Orders Engine — Deployment Runbook

Affiliate-motivation feature. Fake orders flow through the **exact same** order →
commission → notification pipeline as real orders (no second engine), are internally
flagged (`orders.isFake` / `orderSource='FAKE'`), and are excluded from every external
integration (WhatsApp bot, Bemob, CAPI, shipping, invoices, SMS/email).

It runs as its own **standalone PM2 process**, exactly like the UGC engine — a
generation tick can never block a web request, and a session-level PostgreSQL
advisory lock guarantees only one instance ticks at a time.

---

## 1. Apply the migration (additive — safe)

`20260724_fake_orders_engine` (now archived unchanged in `prisma/migrations_archive/`) only adds
columns/tables with `IF NOT EXISTS` + a guarded FK. It touches no existing column, constraint or value.

Since Phase 3C-9A the active chain is a single squashed baseline (`20261025000000_baseline`), which
already contains this engine's tables — see `prisma/migrations/README.md`:
- **Fresh (empty) database:** `npx prisma migrate deploy`, then `npx prisma generate`.
- **Existing database:** do NOT run the baseline. It must first be baselined once with
  `npx prisma migrate resolve --applied 20261025000000_baseline`, only after an approved read-only
  schema/history comparison (procedure in that README). No database has been baselined by the repository.

Then redeploy the web app.

## 2. Ships OFF by default

No `FakeOrderConfig` rows exist on a fresh deploy, so **nothing generates** until an
admin explicitly enables an affiliate. Existing orders are unchanged (`isFake=false`,
`orderSource='REAL'`).

## 3. Configure

Admin → **/admin/affiliates → 🎭 Fake Orders**:

- Select one or many affiliates.
- Set the limits (orders per minute / hour / day), random delay, working hours,
  working days, product scope (all active / selected), then **Start**.

The engine never exceeds the strictest configured limit.

## 4. Start the engine (PM2)

Preferred — via the process manifest (also brings up the UGC engine):

```
pm2 start ecosystem.config.js --only fake-orders-engine   # add to a live host
pm2 save                                                  # survive reboots
```

First time on a host, install the boot hook so PM2 restarts after a reboot:

```
pm2 startup        # run the command it prints (sets up the systemd/init hook)
pm2 save           # snapshot the current process list
```

Standalone (equivalent to the UGC runbook), if not using the manifest:

```
node scripts/fake-orders-engine.mjs --once    # one tick, then exit (smoke test)
node scripts/fake-orders-engine.mjs           # run continuously (~60s tick)
```

Flags: `--once`, `--tick=<ms>` (min 5000). Shuts down gracefully on SIGINT/SIGTERM,
draining the in-flight tick.

## 5. Verify

- **Starts + acquires the lock:** logs `{"event":"boot"}` then `{"event":"lock_connected"}`
  and per-tick `{"event":"tick","emitted":N}`.
- **Single instance only:** start a second process — its `pg_try_advisory_lock`
  returns false, so it logs `no_lock` and emits nothing while the first holds the lock.
- **Automatic generation (no "Lancer un tick"):** with an enabled config inside its
  working window, fake orders appear in Admin → Orders (🎭 Fake badge) and in the
  affiliate's *Mes commandes* on the engine's own cadence.
- **Delivery credits the wallet:** move a fake order to DELIVERED in Admin → Orders;
  the affiliate's commission / balance / delivered-count / ranking update through the
  existing engine.
- **No external calls:** the WhatsApp bot query excludes `isFake` rows and fake orders
  carry no `bemobClickId`, so no customer message / postback / conversion fires.

## 6. Rollback

- Per affiliate: toggle the config **OFF** (or delete it) in the admin panel — takes
  effect on the next tick, no deploy.
- Stop generation entirely: `pm2 stop fake-orders-engine`.
- The columns/table are inert when unused; they can stay.
