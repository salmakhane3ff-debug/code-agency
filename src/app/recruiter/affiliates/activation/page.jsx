"use client";
/**
 * /recruiter/affiliates/activation — affiliates of the recruiter whose credentials are still
 * pending (Affiliate Recruiter System, Phase 6 part 1). Arabic, RTL.
 *
 *   • GET  /api/recruiter/affiliates/activation          → pending list (code STATE only)
 *   • POST /api/recruiter/affiliates/<id>/activation-code → a NEW one-time code (the previous
 *     one is cancelled), shown ONCE in React state — never stored, never fetched again.
 * Refused once the affiliate has set a password (409 ACTIVATION_NOT_AVAILABLE).
 * Phase 6 part 4: when the admin turned off the recruiter's canCreateAffiliates, the list stays
 * visible but no new code can be issued (the server refuses with 403 FORBIDDEN; the button is
 * hidden and a note explains it — the admin recovery path remains for these affiliates).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, KeyRound, RefreshCw } from "lucide-react";
import { toRecruiterError, toRecruiterPendingActivationView } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel } from "../../errorLabels";
import { authAction } from "../../recruiterUiState";
import ActivationCodeCard, { requestNewActivationCode } from "../ActivationCodeCard";

const fmtDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime())
    ? d.toLocaleString("ar-MA", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
};

function StateChip({ state, expiresAt }) {
  if (state === "ACTIVE") {
    return <span className="inline-flex rounded-full bg-emerald-100 text-emerald-800 px-2.5 py-0.5 text-xs font-semibold" data-state="ACTIVE">رمز صالح حتى {fmtDate(expiresAt)}</span>;
  }
  if (state === "EXPIRED") {
    return <span className="inline-flex rounded-full bg-slate-200 text-slate-700 px-2.5 py-0.5 text-xs font-semibold" data-state="EXPIRED">منتهي الصلاحية</span>;
  }
  if (state === "INVALIDATED") {
    return <span className="inline-flex rounded-full bg-red-100 text-red-800 px-2.5 py-0.5 text-xs font-semibold" data-state="INVALIDATED">ملغى بعد محاولات خاطئة</span>;
  }
  return null;
}

export default function RecruiterActivationPage() {
  const router = useRouter();
  const [notice, setNotice] = useState("");
  const [state, setState] = useState({ loading: true, error: "", list: [] });
  const [issued, setIssued] = useState({}); // affiliateId → { code, expiresAt } (memory only)
  const [rowBusy, setRowBusy] = useState("");
  const [rowError, setRowError] = useState({});
  const [canCreate, setCanCreate] = useState(false); // Phase 6 part 4 (from /api/recruiter/me; Stage C: hidden until allowed)
  const [permsUnknown, setPermsUnknown] = useState(false); // Stage C: /me failed (not 401) → note + retry
  const aliveRef = useRef(true);

  const toLogin = useCallback((code) => {
    if (code === "RECRUITER_DISABLED") {
      setNotice(recruiterErrorLabel(code));
      setTimeout(() => { if (aliveRef.current) router.replace("/recruiter/login"); }, 2500);
    } else {
      router.replace("/recruiter/login");
    }
  }, [router]);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const [res, meRes] = await Promise.all([
        fetch("/api/recruiter/affiliates/activation", { credentials: "include", cache: "no-store" }),
        fetch("/api/recruiter/me", { credentials: "include", cache: "no-store" }).catch(() => null),
      ]);
      const body = await res.json().catch(() => null);
      const meBody = meRes?.ok ? await meRes.json().catch(() => null) : null;
      if (!aliveRef.current) return;
      // Stage C: creation stays hidden unless /me explicitly allows it (a failed /me hides it too).
      setCanCreate(meBody?.permissions?.canCreateAffiliates === true);
      setPermsUnknown(!meBody?.permissions);
      if (!res.ok) {
        // ONLY 401 / 403 RECRUITER_DISABLED → login; any other failure → error + retry below.
        const { code } = toRecruiterError(body);
        const action = authAction(res.status, code);
        if (action) { toLogin(action === "disabled" ? code : "UNAUTHORIZED"); return; }
      }
      if (!res.ok) { setState({ loading: false, error: recruiterErrorLabel(toRecruiterError(body).code), list: [] }); return; }
      const list = (Array.isArray(body?.pending) ? body.pending : []).map(toRecruiterPendingActivationView).filter((p) => p.affiliate.id);
      setState({ loading: false, error: "", list });
    } catch {
      if (aliveRef.current) setState({ loading: false, error: recruiterErrorLabel(null), list: [] });
    }
  }, [toLogin]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => { aliveRef.current = false; };
  }, [load]);

  const regenerate = async (id) => {
    if (rowBusy) return;
    if (!window.confirm("سيتم إلغاء الرمز السابق لهذا الأفلييت وإنشاء رمز جديد. هل تريد المتابعة؟")) return;
    setRowBusy(id);
    setRowError((e) => ({ ...e, [id]: "" }));
    try {
      const r = await requestNewActivationCode(id);
      if (!aliveRef.current) return;
      if (r.ok) {
        setIssued((m) => ({ ...m, [id]: r.activation }));
        setState((s) => ({ ...s, list: s.list.map((p) => (p.affiliate.id === id ? { ...p, state: "ACTIVE", expiresAt: r.activation.expiresAt } : p)) }));
      } else if (authAction(r.status, r.code)) {
        toLogin(authAction(r.status, r.code) === "disabled" ? r.code : "UNAUTHORIZED");
      } else if (r.code === "FORBIDDEN") {
        setCanCreate(false); // turned off by the admin meanwhile
      } else {
        setRowError((e) => ({ ...e, [id]: recruiterErrorLabel(r.code) }));
      }
    } catch {
      setRowError((e) => ({ ...e, [id]: recruiterErrorLabel(null) }));
    } finally {
      if (aliveRef.current) setRowBusy("");
    }
  };

  if (notice) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <p role="alert" className="max-w-sm text-center text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3" data-page-notice>{notice}</p>
      </main>
    );
  }

  return (
    <div className="min-h-screen [contain:inline-size]" data-recruiter-activation>
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-2xl mx-auto flex items-center gap-3 px-4 py-3 min-w-0">
          <Link href="/recruiter" className="shrink-0 p-2 -m-2 rounded-lg text-slate-700 hover:bg-slate-100" aria-label="الرجوع للوحة" data-back>
            <ArrowRight className="w-5 h-5" aria-hidden="true" />
          </Link>
          <h1 className="text-base sm:text-lg font-bold truncate">تفعيل حسابات الأفلييت</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 sm:p-6 space-y-4">
        <p className="text-sm text-slate-600">
          هؤلاء الأفلييت لم يختاروا كلمة السر الخاصة بهم بعد. يمكنك إنشاء رمز تفعيل جديد إذا ضاع الرمز أو انتهت صلاحيته.
          الرمز الجديد يلغي الرمز السابق، ويظهر مرة واحدة فقط.
        </p>

        {permsUnknown && !state.loading && !state.error && (
          <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3" data-perms-error>
            <span className="min-w-0">تعذّر التحقق من صلاحياتك. {recruiterErrorLabel(null)}</span>
            <button type="button" onClick={load} className="shrink-0 rounded-xl border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-100" data-retry>إعادة المحاولة</button>
          </div>
        )}
        {!canCreate && !permsUnknown && (
          <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" data-create-disabled>
            إنشاء رموز تفعيل جديدة معطّل لحسابك من طرف الإدارة. يمكن للأفلييت المعني طلب استرجاع التفعيل من الإدارة.
          </p>
        )}

        {state.loading ? (
          <p className="text-sm text-slate-500" aria-live="polite" data-loading>جارٍ التحميل…</p>
        ) : state.error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 space-y-2" data-error>
            <p role="alert" className="text-sm text-red-700">{state.error}</p>
            <button type="button" onClick={load} className="inline-flex items-center gap-2 rounded-xl border border-red-300 bg-white px-3 py-2 text-sm font-semibold" data-retry>
              <RefreshCw className="w-4 h-4" aria-hidden="true" />
              إعادة المحاولة
            </button>
          </div>
        ) : state.list.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-600" data-empty>
            لا يوجد أفلييت في انتظار التفعيل.
          </p>
        ) : (
          <ul className="space-y-3" data-pending-list>
            {state.list.map((p) => (
              <li key={p.affiliate.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 space-y-3 min-w-0" data-pending-row={p.affiliate.username ?? ""}>
                <div className="flex flex-wrap items-start justify-between gap-2 min-w-0">
                  <div className="min-w-0">
                    <p className="font-bold truncate">{p.affiliate.name || "—"}</p>
                    <p className="text-xs text-slate-500 truncate" dir="ltr">{p.affiliate.username}</p>
                  </div>
                  <StateChip state={p.state} expiresAt={p.expiresAt} />
                </div>
                {canCreate && (
                  <button type="button" onClick={() => regenerate(p.affiliate.id)} disabled={rowBusy === p.affiliate.id} data-regenerate={p.affiliate.username ?? ""}
                    className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-60">
                    <KeyRound className="w-4 h-4" aria-hidden="true" />
                    {rowBusy === p.affiliate.id ? "جارٍ الإنشاء…" : "إنشاء رمز جديد"}
                  </button>
                )}
                {rowError[p.affiliate.id] && <p role="alert" className="text-xs text-red-700" data-row-error>{rowError[p.affiliate.id]}</p>}
                {issued[p.affiliate.id] && <ActivationCodeCard activation={issued[p.affiliate.id]} />}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
