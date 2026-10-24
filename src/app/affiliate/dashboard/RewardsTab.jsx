"use client";

/**
 * RewardsTab — affiliate points, gift catalog, gift requests and points history.
 *
 * Language: follows the site language (LanguageContext, FR/AR) via rewardsT.
 * The affiliate dashboard is always LTR at document level, so this tab sets its
 * own `dir` locally (same approach as the Arabic mobile "More" sheet).
 * Eligibility (canRedeem/reason) and all costs come from the server; this UI
 * never decides them and never sends an affiliate id.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Gift, ImageIcon, Truck, Copy, Check, X, ChevronDown, AlertTriangle, Clock } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { rewardsT, rewardsDir, cancellationNote } from "@/lib/rewardsI18n";

function authHeaders(json = false) {
  const t = (typeof localStorage !== "undefined" && localStorage.getItem("affiliateToken")) || "";
  return { Authorization: `Bearer ${t}`, ...(json ? { "Content-Type": "application/json" } : {}) };
}

async function call(url, { method = "GET", body } = {}) {
  try {
    const res = await fetch(url, {
      method, cache: "no-store", headers: authHeaders(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

function newRequestId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const STATUS_CLS = {
  PENDING_REVIEW: "bg-amber-50 text-amber-700", APPROVED: "bg-blue-50 text-blue-700",
  PREPARING: "bg-indigo-50 text-indigo-700", SHIPPED: "bg-purple-50 text-purple-700",
  IN_TRANSIT: "bg-violet-50 text-violet-700", DELIVERED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-red-50 text-red-700", CANCELLED: "bg-gray-100 text-gray-600", RETURNED: "bg-orange-50 text-orange-700",
};

export default function RewardsTab() {
  const { lang } = useLanguage();
  const t = rewardsT(lang);
  const dir = rewardsDir(lang);
  const locale = lang === "ar" ? "ar-MA" : "fr-FR";
  const fmtPts = (n) => `${Number(n || 0).toLocaleString(locale)} ${t("points")}`;
  const fmtDate = (d) => (d ? new Date(d).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "—");
  const codeMsg = (code, vars) => (code ? t(`code_${code}`, vars) : t("error_generic"));

  const [view, setView]         = useState("gifts");
  const [overview, setOverview] = useState(null);
  const [requests, setRequests] = useState(null);
  const [error, setError]       = useState(null);
  const [selected, setSelected] = useState(null);   // gift being requested
  const [notice, setNotice]     = useState(null);

  const loadOverview = useCallback(async () => {
    const r = await call("/api/affiliate/rewards");
    if (r.ok) { setOverview(r.data); setError(null); } else setError(r.status === 0 ? t("error_network") : codeMsg(r.data?.code));
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadRequests = useCallback(async () => {
    const r = await call("/api/affiliate/rewards/redemptions");
    if (r.ok) setRequests(Array.isArray(r.data) ? r.data : []);
  }, []);
  useEffect(() => { loadOverview(); loadRequests(); }, [loadOverview, loadRequests]);

  if (!overview) {
    return (
      <div dir={dir} className="flex justify-center py-16">
        {error ? <p className="text-sm text-red-600">{error}</p> : <Loader2 className="w-7 h-7 animate-spin text-gray-400" />}
      </div>
    );
  }
  const p = overview.points;

  return (
    <div dir={dir} className="space-y-4">
      {/* Header + points */}
      <div className="rounded-3xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white p-5 sm:p-6">
        <div className="flex items-center gap-2"><Gift className="w-5 h-5" /><h2 className="text-lg font-black">{t("title")}</h2></div>
        <p className="text-xs text-white/80 mt-1">{t("subtitle")}</p>
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[["available", p.spendable], ["held", p.held], ["earned", p.totalEarned], ["redeemed", p.totalRedeemed]].map(([k, v]) => (
            <div key={k} className={`rounded-2xl px-3 py-2.5 ${k === "available" ? "bg-white text-violet-700" : "bg-white/15"}`}>
              <p className={`text-[11px] font-semibold ${k === "available" ? "text-violet-500" : "text-white/75"}`}>{t(k)}</p>
              <p className="text-lg font-black tabular-nums">{fmtPts(v)}</p>
            </div>
          ))}
        </div>
        {p.held > 0 && <p className="text-[11px] text-white/80 mt-2 flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {t("held_hint")}</p>}
      </div>

      {!overview.enabled && (
        <p className="text-sm bg-amber-50 text-amber-800 border border-amber-100 rounded-2xl px-4 py-3">{t("disabled")}</p>
      )}
      {p.debt > 0 && (
        <div className="text-sm bg-red-50 text-red-700 border border-red-100 rounded-2xl px-4 py-3 flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span><b>{t("debt")} : {fmtPts(p.debt)}</b><br /><span className="text-xs">{t("debt_hint")}</span></span>
        </div>
      )}
      {notice && (
        <p className="text-sm bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-2xl px-4 py-3 flex items-center justify-between gap-2">
          {notice}<button onClick={() => setNotice(null)} aria-label={t("close")}><X className="w-4 h-4" /></button>
        </p>
      )}

      {/* Sub-tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {[["gifts", "tab_gifts"], ["requests", "tab_requests"], ["history", "tab_history"]].map(([id, key]) => (
          <button key={id} onClick={() => setView(id)}
            className={`whitespace-nowrap px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${view === id ? "bg-gray-900 text-white" : "bg-white border border-gray-200 text-gray-600"}`}>
            {t(key)}
          </button>
        ))}
      </div>

      {view === "gifts" && (
        overview.gifts.length === 0 ? <Empty text={t("no_gifts")} /> : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {overview.gifts.map((g) => (
              <div key={g.id} className="bg-white rounded-2xl border border-gray-100 overflow-hidden flex flex-col">
                <div className="aspect-square bg-gray-50 flex items-center justify-center">
                  {g.images[0]
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={g.images[0]} alt={g.name} className="w-full h-full object-cover" loading="lazy" />
                    : <ImageIcon className="w-8 h-8 text-gray-300" />}
                </div>
                <div className="p-3 flex-1 flex flex-col gap-1.5">
                  <p className="text-sm font-bold text-gray-900 leading-tight line-clamp-2">{g.name}</p>
                  <p className="text-sm font-black text-violet-700">{fmtPts(g.pointsCost)}</p>
                  <span className={`self-start text-[10px] font-semibold px-2 py-0.5 rounded-full ${g.stockState === "OUT" ? "bg-red-50 text-red-600" : g.stockState === "LOW" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
                    {g.stockState === "OUT" ? t("stock_out") : g.stockState === "LOW" ? t("stock_low", { n: g.remaining }) : t("stock_ok")}
                  </span>
                  <div className="mt-auto pt-1">
                    <button disabled={!g.canRedeem} onClick={() => setSelected(g)}
                      className="w-full py-2 rounded-xl text-xs font-bold bg-violet-600 text-white hover:bg-violet-700 disabled:bg-gray-100 disabled:text-gray-400">
                      {t("request")}
                    </button>
                    {!g.canRedeem && g.reason && (
                      <p className="text-[10px] text-gray-500 mt-1 leading-snug">{codeMsg(g.reason, { n: g.minDeliveredOrders })}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {view === "requests" && (
        <RequestsList requests={requests} t={t} lang={lang} fmtPts={fmtPts} fmtDate={fmtDate} codeMsg={codeMsg}
          onChanged={() => { loadRequests(); loadOverview(); }} />
      )}

      {view === "history" && <PointsHistory t={t} fmtDate={fmtDate} />}

      {selected && (
        <RequestModal gift={selected} spendable={p.spendable} t={t} fmtPts={fmtPts} codeMsg={codeMsg} dir={dir}
          onClose={() => setSelected(null)}
          onDone={(ref) => { setSelected(null); setNotice(t("success", { ref })); setView("requests"); loadRequests(); loadOverview(); }} />
      )}
    </div>
  );
}

function Empty({ text }) {
  return <div className="bg-white rounded-2xl border border-gray-100 py-12 text-center text-sm text-gray-400">{text}</div>;
}

function RequestModal({ gift, spendable, t, fmtPts, codeMsg, dir, onClose, onDone }) {
  const [step, setStep] = useState("form");
  const [form, setForm] = useState({ fullName: "", phone: "", city: "", address: "", deliveryNotes: "" });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [requestId] = useState(newRequestId); // one id per modal → a double submit can't create two requests

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const localCheck = () => {
    const e = {};
    if (form.fullName.trim().length < 2) e.fullName = true;
    if (!/^\+?\d{8,15}$/.test(form.phone.replace(/[\s.\-()]/g, ""))) e.phone = true;
    if (form.city.trim().length < 2) e.city = true;
    if (form.address.trim().length < 5) e.address = true;
    if (form.deliveryNotes.length > 500) e.deliveryNotes = true;
    setErrors(e);
    return Object.keys(e).length === 0;
  };
  const submit = async () => {
    setBusy(true); setError(null);
    const r = await call("/api/affiliate/rewards/redemptions", {
      method: "POST", body: { giftId: gift.id, clientRequestId: requestId, ...form },
    });
    setBusy(false);
    if (r.ok) return onDone(r.data.redemption.reference);
    if (r.data?.errors) { setErrors(Object.fromEntries(Object.keys(r.data.errors).map((k) => [k, true]))); setStep("form"); }
    setError(r.status === 0 ? t("error_network") : r.status === 429 ? t("code_RATE_LIMITED") : codeMsg(r.data?.code, { n: gift.minDeliveredOrders }));
  };

  const field = (key, label, props = {}) => (
    <label className="block">
      <span className="text-xs font-semibold text-gray-600">{label}</span>
      <input value={form[key]} onChange={set(key)} className={`mt-1 w-full text-sm border rounded-xl px-3 py-2.5 bg-gray-50 focus:outline-none ${errors[key] ? "border-red-300" : "border-gray-200 focus:border-gray-400"}`} {...props} />
      {errors[key] && <span className="text-[11px] text-red-600">{t(`err_${key}`)}</span>}
    </label>
  );

  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-end sm:items-center justify-center sm:p-4" onClick={busy ? undefined : onClose}>
      <div dir={dir} onClick={(e) => e.stopPropagation()}
        className="bg-white w-full sm:max-w-md rounded-t-[28px] sm:rounded-3xl shadow-2xl max-h-[92vh] overflow-y-auto"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="sticky top-0 bg-white flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-black text-gray-900">{step === "form" ? t("form_title") : t("confirm_title")}</h3>
          <button onClick={onClose} disabled={busy} aria-label={t("close")} className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          {/* Gift summary */}
          <div className="flex items-center gap-3 bg-gray-50 rounded-2xl p-3">
            <div className="w-14 h-14 rounded-xl bg-white overflow-hidden flex items-center justify-center shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {gift.images[0] ? <img src={gift.images[0]} alt="" className="w-full h-full object-cover" /> : <ImageIcon className="w-6 h-6 text-gray-300" />}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray-900 truncate">{gift.name}</p>
              <p className="text-xs text-gray-500">{t("cost")} : <b className="text-violet-700">{fmtPts(gift.pointsCost)}</b></p>
            </div>
          </div>
          {error && <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2">{error}</p>}

          {step === "form" ? (
            <>
              {field("fullName", t("full_name"), { autoComplete: "name", maxLength: 100 })}
              {field("phone", t("phone"), { type: "tel", autoComplete: "tel", inputMode: "tel", dir: "ltr" })}
              {field("city", t("city"), { autoComplete: "address-level2", maxLength: 80 })}
              {field("address", t("address"), { autoComplete: "street-address", maxLength: 300 })}
              {field("deliveryNotes", t("notes"), { maxLength: 500 })}
              <button onClick={() => localCheck() && setStep("confirm")}
                className="w-full py-3 rounded-2xl text-sm font-bold bg-violet-600 text-white hover:bg-violet-700">{t("continue")}</button>
            </>
          ) : (
            <>
              <dl className="text-sm divide-y divide-gray-100 border border-gray-100 rounded-2xl">
                <div className="flex justify-between gap-3 px-4 py-2.5"><dt className="text-gray-500">{t("cost")}</dt><dd className="font-bold text-violet-700">{fmtPts(gift.pointsCost)}</dd></div>
                <div className="flex justify-between gap-3 px-4 py-2.5"><dt className="text-gray-500">{t("balance_after")}</dt><dd className="font-bold">{fmtPts(spendable - gift.pointsCost)}</dd></div>
                <div className="px-4 py-2.5"><dt className="text-gray-500 text-xs">{t("deliver_to")}</dt>
                  <dd className="text-gray-900">{form.fullName} · <span dir="ltr">{form.phone}</span><br />{form.address}, {form.city}{form.deliveryNotes && <><br /><span className="text-xs text-gray-500">{form.deliveryNotes}</span></>}</dd></div>
              </dl>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setStep("form")} disabled={busy} className="py-3 rounded-2xl text-sm font-bold bg-gray-100 text-gray-700">{t("back")}</button>
                <button onClick={submit} disabled={busy} className="py-3 rounded-2xl text-sm font-bold bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-60 inline-flex items-center justify-center gap-1.5">
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />} {t("confirm")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RequestsList({ requests, t, lang, fmtPts, fmtDate, codeMsg, onChanged }) {
  const [open, setOpen]     = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [copied, setCopied] = useState(null);
  const [error, setError]   = useState(null);

  if (!requests) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>;
  if (requests.length === 0) return <Empty text={t("no_requests")} />;

  const cancel = async (r) => {
    if (!confirm(t("cancel_confirm"))) return;
    setBusyId(r.id); setError(null);
    const res = await call(`/api/affiliate/rewards/redemptions/${r.id}/cancel`, { method: "POST" });
    setBusyId(null);
    if (res.ok) onChanged(); else setError(res.status === 429 ? t("code_RATE_LIMITED") : codeMsg(res.data?.code));
  };
  const copy = (r) => navigator.clipboard?.writeText(r.trackingNumber).then(() => { setCopied(r.id); setTimeout(() => setCopied(null), 1500); }).catch(() => {});

  return (
    <div className="space-y-2">
      {error && <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2">{error}</p>}
      {requests.map((r) => (
        <div key={r.id} className="bg-white rounded-2xl border border-gray-100 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray-900 truncate">{r.giftSnapshot?.name}</p>
              <p className="text-[11px] text-gray-500 mt-0.5">
                {t("reference")} <span className="font-mono" dir="ltr">{r.reference}</span> · {t("requested_on")} {fmtDate(r.createdAt)}
              </p>
            </div>
            <span className="text-sm font-black text-violet-700 whitespace-nowrap">{fmtPts(r.pointsCost)}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${STATUS_CLS[r.status] || "bg-gray-100 text-gray-600"}`}>{t(`status_${r.status}`)}</span>
            {r.status === "PENDING_REVIEW" && (
              <button disabled={busyId === r.id} onClick={() => cancel(r)} className="text-[11px] font-semibold text-red-600 hover:underline disabled:opacity-50">
                {busyId === r.id ? "…" : t("cancel_request")}
              </button>
            )}
          </div>
          {(r.carrierName || r.trackingNumber) && (
            <div className="mt-2 text-xs text-gray-700 bg-gray-50 rounded-xl px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1"><Truck className="w-3.5 h-3.5" /> {t("carrier")} : <b>{r.carrierName || "—"}</b></span>
              {r.trackingNumber && (
                <span className="inline-flex items-center gap-1">{t("tracking")} : <b className="font-mono" dir="ltr">{r.trackingNumber}</b>
                  <button onClick={() => copy(r)} aria-label={t("copy")} className="text-gray-400 hover:text-gray-700">
                    {copied === r.id ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </span>
              )}
              {r.trackingUrl && <a href={r.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-violet-700 underline">{t("track_link")}</a>}
            </div>
          )}
          {r.rejectionReason && <p className="text-xs text-red-600 mt-2">{t("rejection_reason")} : {r.rejectionReason}</p>}
          {r.status === "CANCELLED" && <p className="text-xs text-gray-500 mt-2">{cancellationNote(r, lang)}</p>}
          {r.history?.length > 0 && (
            <>
              <button onClick={() => setOpen(open === r.id ? null : r.id)} className="mt-2 text-[11px] font-semibold text-gray-500 inline-flex items-center gap-1">
                {t("history")} <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open === r.id ? "rotate-180" : ""}`} />
              </button>
              {open === r.id && (
                <ol className="mt-2 space-y-1.5 border-s-2 border-gray-100 ps-3">
                  {r.history.map((h, i) => (
                    <li key={i} className="text-[11px] text-gray-600"><b className="text-gray-800">{t(`status_${h.toStatus}`)}</b> · {fmtDate(h.createdAt)}</li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function PointsHistory({ t, fmtDate }) {
  const [items, setItems]   = useState(null);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (more = null) => {
    setLoading(true);
    const r = await call(`/api/affiliate/rewards/ledger${more ? `?cursor=${encodeURIComponent(more)}` : ""}`);
    if (r.ok) { setItems((prev) => (more ? [...(prev || []), ...r.data.items] : r.data.items)); setCursor(r.data.nextCursor); }
    else if (!more) setItems([]);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!items) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>;
  if (items.length === 0) return <Empty text={t("no_history")} />;
  return (
    <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50">
      {items.map((l) => (
        <div key={l.id} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900">{t(`ledger_${l.type}`)}</p>
            <p className="text-[11px] text-gray-500">{fmtDate(l.createdAt)}</p>
          </div>
          <div className="text-end">
            <p className={`text-sm font-black tabular-nums ${l.delta < 0 ? "text-red-600" : "text-emerald-600"}`} dir="ltr">{l.delta > 0 ? "+" : ""}{l.delta}</p>
            <p className="text-[10px] text-gray-400 tabular-nums" dir="ltr">= {l.balanceAfter}</p>
          </div>
        </div>
      ))}
      {cursor && <div className="p-3"><button onClick={() => load(cursor)} disabled={loading} className="w-full py-2 rounded-xl text-xs font-semibold bg-gray-50 text-gray-700 border border-gray-200">{loading ? "…" : t("load_more")}</button></div>}
    </div>
  );
}
