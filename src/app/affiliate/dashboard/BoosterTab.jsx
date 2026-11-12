"use client";

/**
 * 🚀 Starter Booster — investment-dashboard UX.
 * PRESENTATION ONLY: every number comes from /api/affiliate/boosters (packages,
 * balance breakdown, and progress derived server-side from the affiliate's real
 * orders since activation). Purchase/wallet/accounting logic is untouched — the
 * page still POSTs the same { packageId, method } payload.
 *
 * Layout: mobile-first single column; desktop switches to two columns where it
 * helps (packages grid, active dashboard + timeline).
 *
 * Language follows the visitor's market (useMarketLocale → AFFILIATE_TABS_TEXT,
 * bst_* keys): MA → Arabic / RTL, FR → French / LTR. The tab inherits `dir` from
 * the affiliate layout (no pinned direction); amounts are <bdi> islands and
 * ratios / signed counts are LTR islands.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, Rocket, Wallet, CreditCard, CheckCircle, AlertCircle, X, ChevronLeft, ChevronRight, Target, CalendarDays, TrendingUp } from "lucide-react";
import { useMarketLocale } from "@/context/useMarketLocale";
import { AFFILIATE_TABS_TEXT, fillParts } from "@/lib/affiliateTabsI18n";
import { localizeServerError } from "@/lib/serverText/affiliateServerText";

/** Shared formatters for the current market (amount, sales word, days). */
function useBoosterText() {
  const m = useMarketLocale(AFFILIATE_TABS_TEXT);
  const { t, lang, intlLocale } = m;
  // French: 0 or 1 → singular ("1 vente"); Arabic keeps the site's existing rule (1 → مبيعة).
  const one = (n) => (lang === "fr" ? Math.abs(Number(n) || 0) < 2 : n === 1);
  return {
    ...m,
    fmt: (n) => `${Number(n || 0).toLocaleString(intlLocale)} ${t("bst_currency")}`,
    salesWord: (n) => (one(n) ? t("bst_sale_one") : t("bst_sale_many")),
    days: (n) => (one(n) ? t("bst_day_one", { n }) : t("bst_days", { n })),
  };
}

function authHeaders() {
  const t = (typeof localStorage !== "undefined" && localStorage.getItem("affiliateToken")) || "";
  return { Authorization: `Bearer ${t}` };
}

// ── Hero ──────────────────────────────────────────────────────────────────────
function BoosterHero() {
  const { t } = useBoosterText();
  return (
    <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-violet-600 via-indigo-600 to-blue-600 text-white p-6 sm:p-8">
      <div className="absolute -top-8 -start-8 w-40 h-40 rounded-full bg-white/10 blur-2xl" />
      <div className="absolute -bottom-10 -end-4 w-48 h-48 rounded-full bg-fuchsia-400/20 blur-3xl" />
      <div className="relative flex items-start gap-4">
        <div className="text-5xl animate-[bstFloat_3s_ease-in-out_infinite] shrink-0">🚀</div>
        <div className="min-w-0">
          <h2 className="text-xl sm:text-2xl font-black leading-tight">{t("bst_title")}</h2>
          <p className="text-sm font-bold text-white/90 mt-1">{t("bst_tagline")}</p>
          <p className="text-xs text-white/70 mt-1.5 leading-relaxed">
            {t("bst_intro")}
          </p>
        </div>
      </div>
      <div className="relative grid gap-2 mt-5">
        {["bst_point_no_confirm", "bst_point_gradual", "bst_point_pay"].map((k) => (
          <div key={k} className="rounded-xl bg-white/10 backdrop-blur px-3.5 py-2.5 text-xs font-semibold">{t(k)}</div>
        ))}
      </div>
      <style>{`@keyframes bstFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}`}</style>
    </div>
  );
}

// ── Package card ──────────────────────────────────────────────────────────────
function PackageCard({ pkg, owned, onChoose }) {
  const { t, fmt, salesWord, days } = useBoosterText();
  const rows = [
    { key: "price", label: t("bst_price"), value: <bdi>{fmt(pkg.price)}</bdi>, strong: true },
    pkg.durationDays ? { key: "duration", label: t("bst_duration"), value: days(pkg.durationDays), icon: CalendarDays } : null,
    pkg.targetSales ? { key: "target", label: t("bst_target"), value: t("bst_target_value", { n: pkg.targetSales, sales: salesWord(pkg.targetSales) }), icon: Target } : null,
    (pkg.dailyMin || pkg.dailyMax)
      ? { key: "daily", label: t("bst_expected"), value: fillParts(t("bst_daily_range"), { range: <bdi key="range" dir="ltr">{`${pkg.dailyMin}–${pkg.dailyMax}`}</bdi> }), icon: TrendingUp } : null,
  ].filter(Boolean);

  return (
    <div className="rounded-3xl bg-white border border-gray-100 shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all p-5 flex flex-col">
      <div className="flex items-center justify-between gap-2">
        <div className="w-12 h-12 rounded-2xl bg-violet-50 flex items-center justify-center text-2xl">{pkg.emoji || "🚀"}</div>
        {pkg.targetSales > 0 && (
          <span className="px-2.5 py-1 rounded-full bg-violet-100 text-violet-700 text-[11px] font-black">
            <Target className="w-3 h-3 inline me-1" />{pkg.targetSales} {salesWord(pkg.targetSales)}
          </span>
        )}
      </div>
      <h3 dir="auto" className="text-base font-black text-gray-900 mt-3 text-start">{pkg.name}</h3>
      {pkg.description && <p dir="auto" className="text-xs text-gray-500 mt-1 text-start">{pkg.description}</p>}

      <div className="mt-4 rounded-2xl bg-gray-50 divide-y divide-gray-100">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between px-3.5 py-2.5">
            <span className="text-[11px] text-gray-500 flex items-center gap-1.5">
              {r.icon ? <r.icon className="w-3.5 h-3.5 text-gray-400" /> : null}{r.label}
            </span>
            <span className={r.strong ? "text-base font-black text-gray-900" : "text-xs font-bold text-gray-700"}>{r.value}</span>
          </div>
        ))}
      </div>

      <button type="button" disabled={owned} onClick={() => onChoose(pkg)}
        className="mt-4 w-full py-3.5 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white text-sm font-black shadow-lg shadow-violet-200 active:scale-[0.98] transition-all disabled:opacity-40 disabled:shadow-none">
        {owned ? t("bst_owned") : t("bst_choose")}
      </button>
    </div>
  );
}

// ── Active booster dashboard ──────────────────────────────────────────────────
function ActiveBooster({ v }) {
  const { t, days } = useBoosterText();
  const pct = v.percent ?? 0;
  return (
    <div className="rounded-3xl bg-white border border-gray-100 shadow-sm p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-base font-black text-gray-900">🚀 <bdi>{v.packageName}</bdi></h3>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-50 text-green-600 text-[11px] font-black">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> {t("bst_active")}
        </span>
      </div>

      {v.target ? (
        <>
          <div className="mt-4 h-3 rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-700"
              style={{ width: `${pct}%` }} />
          </div>
          <div className="flex items-center justify-between mt-2">
            <span dir="ltr" className="text-sm font-black text-gray-900">{v.sales} / {v.target}</span>
            <span dir="ltr" className="text-sm font-black text-violet-600">{pct}%</span>
          </div>
        </>
      ) : (
        <p className="mt-4 text-xs text-gray-400">{t("bst_no_target")}</p>
      )}

      <div className="grid grid-cols-3 gap-2 mt-4">
        <div className="rounded-2xl bg-gray-50 px-3 py-3 text-center">
          <p className="text-[11px] text-gray-500">{t("bst_today")}</p>
          <p dir="ltr" className="text-lg font-black text-green-600">+{v.todaySales}</p>
        </div>
        <div className="rounded-2xl bg-gray-50 px-3 py-3 text-center">
          <p className="text-[11px] text-gray-500">{t("bst_remaining")}</p>
          <p className="text-lg font-black text-gray-900">{v.remaining ?? "—"}</p>
        </div>
        <div className="rounded-2xl bg-gray-50 px-3 py-3 text-center">
          <p className="text-[11px] text-gray-500">{t("bst_ends_in")}</p>
          <p className="text-lg font-black text-gray-900">{v.daysLeft != null ? days(v.daysLeft) : "—"}</p>
        </div>
      </div>
    </div>
  );
}

// ── Activity timeline ─────────────────────────────────────────────────────────
// The rail and the dots sit on the START side (right in Arabic, left in French).
function Timeline({ items }) {
  const { t, salesWord } = useBoosterText();
  if (!items?.length) {
    return (
      <div className="rounded-3xl bg-white border border-gray-100 shadow-sm p-5">
        <p className="text-xs font-bold text-gray-700 mb-2">{t("bst_activity_today")}</p>
        <p className="text-xs text-gray-400">{t("bst_no_activity")}</p>
      </div>
    );
  }
  return (
    <div className="rounded-3xl bg-white border border-gray-100 shadow-sm p-5">
      <p className="text-xs font-bold text-gray-700 mb-3">{t("bst_activity_today")}</p>
      <ol className="relative">
        {items.map((it, i) => (
          <li key={it.at} className="relative ps-6 pb-4 last:pb-0 animate-[bstIn_0.35s_ease]" style={{ animationDelay: `${i * 40}ms` }}>
            {i < items.length - 1 && <span className="absolute start-[5px] top-3 bottom-0 w-px bg-gray-200" />}
            <span className="absolute start-0 top-1.5 w-2.5 h-2.5 rounded-full bg-violet-500 ring-4 ring-violet-100" />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-gray-800 tabular-nums"><bdi>{it.label}</bdi></span>
              <span className="text-xs font-black text-green-600"><bdi dir="ltr">+{it.count}</bdi> {salesWord(it.count)}</span>
            </div>
          </li>
        ))}
      </ol>
      <style>{`@keyframes bstIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}

// ── Past boosters ─────────────────────────────────────────────────────────────
function PastBoosters({ items }) {
  const { t, fmt, salesWord } = useBoosterText();
  if (!items?.length) return null;
  return (
    <div className="rounded-3xl bg-white border border-gray-100 shadow-sm p-5">
      <p className="text-sm font-black text-gray-900 mb-3">{t("bst_past")}</p>
      <div className="space-y-2">
        {items.map((v) => {
          const refused = v.status === "REJECTED";
          return (
            <div key={v.id} className="flex items-center justify-between gap-3 rounded-2xl bg-gray-50 px-4 py-3">
              <div className="min-w-0">
                <p dir="auto" className="text-sm font-bold text-gray-800 truncate text-start">{v.packageName}</p>
                <p className="text-[11px] text-gray-500">
                  {v.target ? <bdi dir="ltr">{`${v.sales} / ${v.target}`}</bdi> : `${v.sales} ${salesWord(v.sales)}`}
                  {v.earnings > 0 && <> · {t("bst_total_earnings")} <strong className="text-green-600"><bdi>{fmt(v.earnings)}</bdi></strong></>}
                </p>
              </div>
              <span className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-black ${refused ? "bg-red-100 text-red-600" : "bg-green-100 text-green-700"}`}>
                {refused ? t("bst_rejected") : t("bst_completed")}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function BoosterTab({ onRecharge }) {
  const { t, dir, fmt, lang } = useBoosterText();
  const BackIcon = dir === "rtl" ? ChevronRight : ChevronLeft;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null); // package pending confirmation
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/affiliate/boosters", { headers: authHeaders(), cache: "no-store" });
      setData(await r.json());
    } catch { setData(null); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const balance = Number(data?.balance || 0);
  const topupAvailable = Number(data?.topupAvailable || 0);
  const active = data?.active || [];
  const past = data?.past || [];
  const pendingPurchases = data?.pendingPurchases || [];
  const sufficient = selected ? balance >= selected.price : false;
  const fromTopup = selected ? Math.min(topupAvailable, selected.price) : 0;
  const fromEarnings = selected ? Math.max(0, selected.price - fromTopup) : 0;

  const buy = async (method) => {
    if (!selected || busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/affiliate/boosters", {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ packageId: selected.id, method }),
      });
      const d = await r.json();
      // Own messages are kept as { key, vars } so they re-translate live; server text (+ code) is localized at display.
      if (!r.ok) { setMsg(d?.error ? { ok: false, text: d.error, code: d.code } : { ok: false, key: "bst_error" }); return; }
      setMsg(method === "BALANCE"
        ? { ok: true, key: "bst_activated_balance", vars: { name: selected.name } }
        : { ok: true, key: "bst_request_saved" });
      setSelected(null);
      await load();
    } catch { setMsg({ ok: false, key: "bst_network_error" }); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>;

  if (!data?.enabled || !(data?.packages || []).length) {
    return (
      <div className="space-y-4">
        <BoosterHero />
        <div className="bg-white rounded-3xl border border-gray-100 p-10 text-center">
          <Rocket className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-bold text-gray-700">{t("bst_soon_title")}</p>
          <p className="text-xs text-gray-400 mt-1">{t("bst_soon_body")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {msg && (
        <div className={`flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium ${msg.ok ? "bg-green-50 border border-green-100 text-green-700" : "bg-red-50 border border-red-100 text-red-700"}`}>
          {msg.ok ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}{msg.key ? t(msg.key, msg.vars) : localizeServerError(msg, lang)}
        </div>
      )}

      <BoosterHero />

      {/* Wallet strip (same numbers as before — one wallet, two components) */}
      <div className="rounded-3xl bg-white border border-gray-100 shadow-sm p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-2xl bg-violet-50 flex items-center justify-center text-violet-600"><Wallet className="w-5 h-5" /></div>
          <div>
            <p className="text-[11px] text-gray-500">{t("bst_balance_label")}</p>
            <p className="text-lg font-black text-gray-900"><bdi>{fmt(balance)}</bdi></p>
          </div>
        </div>
        {topupAvailable > 0 && (
          <p className="text-[11px] text-gray-500">{fillParts(t("bst_topup_part"), { amount: <strong key="amount"><bdi>{fmt(topupAvailable)}</bdi></strong> })}</p>
        )}
        {/* onRecharge is null while the admin switch "Recharge de solde des Affiliés" is OFF → no recharge shortcut */}
        {onRecharge && <button type="button" onClick={onRecharge} className="text-xs font-bold px-3.5 py-2 rounded-xl bg-amber-400 hover:bg-amber-500 text-gray-900">{t("bst_recharge")}</button>}
      </div>

      {/* Active boosters — dashboard + timeline (2 columns on desktop) */}
      {active.map((v) => (
        <div key={v.id} className="grid lg:grid-cols-2 gap-4 items-start">
          <ActiveBooster v={v} />
          <Timeline items={v.timeline} />
        </div>
      ))}

      {pendingPurchases.length > 0 && (
        <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          {t("bst_pending_count", { n: pendingPurchases.length })}
        </div>
      )}

      {/* Packages */}
      <div>
        <p className="text-sm font-black text-gray-900 mb-3 px-1">{t("bst_choose_pack")}</p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.packages.map((p) => (
            <PackageCard key={p.id} pkg={p}
              owned={!data.allowStacking && [...active, ...pendingPurchases].some((v) => v.packageId === p.id)}
              onChoose={setSelected} />
          ))}
        </div>
      </div>

      <PastBoosters items={past} />

      {/* Confirmation modal — nothing is purchased before this is confirmed */}
      {selected && (
        <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center" onClick={() => !busy && setSelected(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div dir={dir} className="relative w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 animate-[bstUp_0.25s_ease] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <p className="text-base font-black text-gray-900">{selected.emoji || "🚀"} <bdi>{selected.name}</bdi></p>
              <button type="button" onClick={() => setSelected(null)} aria-label={t("bst_close")} className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
            </div>

            <div className="rounded-2xl bg-gray-50 divide-y divide-gray-100 text-sm">
              <div className="flex justify-between px-4 py-2.5"><span className="text-gray-500">{t("bst_price")}</span><strong><bdi>{fmt(selected.price)}</bdi></strong></div>
              <div className="flex justify-between px-4 py-2.5"><span className="text-gray-500">{t("bst_current_balance")}</span><strong><bdi>{fmt(balance)}</bdi></strong></div>
              {sufficient && (
                <div className="flex justify-between px-4 py-2.5"><span className="text-gray-500">{t("bst_after_purchase")}</span><strong className="text-green-600"><bdi>{fmt(balance - selected.price)}</bdi></strong></div>
              )}
              {sufficient && fromTopup > 0 && (
                <div className="flex justify-between px-4 py-2 text-xs">
                  <span className="text-gray-400">{t("bst_split")}</span>
                  <span className="text-gray-600 font-semibold"><bdi>{fmt(fromTopup)}</bdi> / <bdi>{fmt(fromEarnings)}</bdi></span>
                </div>
              )}
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-gray-500">{t("bst_pay_method")}</span>
                <strong className={sufficient ? "text-green-600" : "text-gray-700"}>{sufficient ? t("bst_pay_balance") : t("bst_pay_card")}</strong>
              </div>
            </div>

            {sufficient ? (
              <button type="button" onClick={() => buy("BALANCE")} disabled={busy}
                className="mt-5 w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-black text-sm shadow-lg shadow-violet-200 active:scale-[0.98] transition-all disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "🚀"} {t("bst_activate")}
              </button>
            ) : (
              <div className="mt-5 space-y-2">
                <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm">
                  <p className="font-bold text-amber-800">{t("bst_insufficient")}</p>
                  <p className="text-amber-700 mt-0.5">{t("bst_missing")} <strong><bdi>{fmt(selected.price - balance)}</bdi></strong></p>
                </div>
                <div className={`grid ${onRecharge ? "grid-cols-2" : "grid-cols-1"} gap-2`}>
                  <button type="button" onClick={() => buy("CARD")} disabled={busy}
                    className="flex items-center justify-center gap-1.5 py-3.5 rounded-2xl bg-gray-900 hover:bg-black text-white text-xs font-black disabled:opacity-50">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />} {t("bst_pay_by_card")}
                  </button>
                  {onRecharge && <button type="button" onClick={onRecharge}
                    className="flex items-center justify-center gap-1.5 py-3.5 rounded-2xl bg-amber-400 hover:bg-amber-500 text-gray-900 text-xs font-black">
                    <Wallet className="w-4 h-4" /> {t("bst_recharge_plain")}
                  </button>}
                </div>
              </div>
            )}
            <button type="button" onClick={() => setSelected(null)} disabled={busy}
              className="mt-2 w-full py-3 rounded-2xl text-gray-500 text-xs font-bold hover:bg-gray-50 flex items-center justify-center gap-1">
              <BackIcon className="w-3.5 h-3.5" /> {t("bst_back")}
            </button>
          </div>
          <style>{`@keyframes bstUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}`}</style>
        </div>
      )}
    </div>
  );
}
