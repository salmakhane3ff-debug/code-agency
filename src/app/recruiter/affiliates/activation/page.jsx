"use client";
/**
 * /recruiter/affiliates/activation — affiliates of the recruiter whose credentials are still
 * pending (Affiliate Recruiter System, Phase 6 part 1). Market language (MA → Arabic RTL, FR → French LTR).
 *
 *   • GET  /api/recruiter/affiliates/activation          → pending list (code STATE only)
 *   • POST /api/recruiter/affiliates/<id>/activation-code → a NEW one-time code (the previous
 *     one is cancelled), shown ONCE in React state — never stored, never fetched again.
 * Refused once the affiliate has set a password (409 ACTIVATION_NOT_AVAILABLE).
 * Phase 6 part 4: when the admin turned off the recruiter's canCreateAffiliates, the list stays
 * visible but no new code can be issued (the server refuses with 403 FORBIDDEN; the button is
 * hidden and a note explains it — the admin recovery path remains for these affiliates).
 * Phase 2 (UI only): rendered inside the recruiter app shell with the shared ui.jsx primitives.
 * Errors are kept as CODES in state and rendered in the current market language (they switch live).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, RefreshCw, UserCheck } from "lucide-react";
import { toRecruiterError, toRecruiterPendingActivationView } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel } from "../../errorLabels";
import { authAction } from "../../recruiterUiState";
import ActivationCodeCard, { requestNewActivationCode } from "../ActivationCodeCard";
import { Badge, Card, CenteredNotice, EmptyState, LoadingBlock, PageHeader, ui, useRecruiterLocale } from "../../_components/ui";

const fmtDate = (iso, locale) => {
  const d = iso ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime())
    ? d.toLocaleString(locale, { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
};

function StateChip({ state, expiresAt }) {
  const { t, intlLocale } = useRecruiterLocale();
  if (state === "ACTIVE") {
    return <Badge tone="green" data-state="ACTIVE">{t("act_valid_until")} <bdi>{fmtDate(expiresAt, intlLocale)}</bdi></Badge>;
  }
  if (state === "EXPIRED") {
    return <Badge tone="slate" data-state="EXPIRED">{t("act_expired")}</Badge>;
  }
  if (state === "INVALIDATED") {
    return <Badge tone="red" data-state="INVALIDATED">{t("act_invalidated")}</Badge>;
  }
  return null;
}

export default function RecruiterActivationPage() {
  const router = useRouter();
  const { t, lang } = useRecruiterLocale();
  const [notice, setNotice] = useState(""); // error CODE (RECRUITER_DISABLED)
  const [state, setState] = useState({ loading: true, error: "", list: [] });
  const [issued, setIssued] = useState({}); // affiliateId → { code, expiresAt } (memory only)
  const [rowBusy, setRowBusy] = useState("");
  const [rowError, setRowError] = useState({}); // affiliateId → error CODE
  const [canCreate, setCanCreate] = useState(false); // Phase 6 part 4 (from /api/recruiter/me; Stage C: hidden until allowed)
  const [permsUnknown, setPermsUnknown] = useState(false); // Stage C: /me failed (not 401) → note + retry
  const aliveRef = useRef(true);

  const toLogin = useCallback((code) => {
    if (code === "RECRUITER_DISABLED") {
      setNotice(code);
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
      if (!res.ok) { setState({ loading: false, error: toRecruiterError(body).code, list: [] }); return; }
      const list = (Array.isArray(body?.pending) ? body.pending : []).map(toRecruiterPendingActivationView).filter((p) => p.affiliate.id);
      setState({ loading: false, error: "", list });
    } catch {
      if (aliveRef.current) setState({ loading: false, error: "SERVER_ERROR", list: [] });
    }
  }, [toLogin]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => { aliveRef.current = false; };
  }, [load]);

  const regenerate = async (id) => {
    if (rowBusy) return;
    if (!window.confirm(t("act_confirm_regenerate"))) return;
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
        setRowError((e) => ({ ...e, [id]: r.code }));
      }
    } catch {
      setRowError((e) => ({ ...e, [id]: "SERVER_ERROR" }));
    } finally {
      if (aliveRef.current) setRowBusy("");
    }
  };

  if (notice) return <CenteredNotice>{recruiterErrorLabel(notice, lang)}</CenteredNotice>;

  return (
    <div className="space-y-5 min-w-0" data-recruiter-activation>
      <PageHeader Icon={KeyRound} title={t("act_title")} subtitle={t("act_subtitle")} />

      {permsUnknown && !state.loading && !state.error && (
        <div role="alert" className="rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3" data-perms-error>
          <span className="min-w-0">{t("act_perms_failed")} {recruiterErrorLabel(null, lang)}</span>
          <button type="button" onClick={load} data-retry
            className="shrink-0 inline-flex items-center gap-1.5 min-h-10 rounded-xl border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-100">
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            {t("common_retry")}
          </button>
        </div>
      )}
      {!canCreate && !permsUnknown && (
        <p className="rounded-xl border border-amber-100 bg-amber-50 p-4 text-sm text-amber-700" data-create-disabled>
          {t("act_create_disabled")}
        </p>
      )}

      {state.loading ? (
        <LoadingBlock />
      ) : state.error ? (
        <div className="rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3" data-error>
          <p role="alert" className="min-w-0">{recruiterErrorLabel(state.error, lang)}</p>
          <button type="button" onClick={load} data-retry
            className="shrink-0 inline-flex items-center gap-1.5 min-h-10 rounded-xl border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-100">
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            {t("common_retry")}
          </button>
        </div>
      ) : state.list.length === 0 ? (
        <Card className={ui.cardPad}>
          <div data-empty>
            <EmptyState Icon={UserCheck} text={t("act_empty")} />
          </div>
        </Card>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2 items-start min-w-0" data-pending-list>
          {state.list.map((p) => (
            <li key={p.affiliate.id} className={`${ui.card} ${ui.cardPad} space-y-4`} data-pending-row={p.affiliate.username ?? ""}>
              <div className="flex flex-wrap items-start justify-between gap-3 min-w-0">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="grid place-items-center w-9 h-9 shrink-0 rounded-xl bg-gray-100 text-gray-600" aria-hidden="true">
                    <KeyRound className="w-[18px] h-[18px]" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-900 truncate">{p.affiliate.name || "—"}</p>
                    <p className="text-xs text-gray-500 truncate" dir="ltr">{p.affiliate.username}</p>
                  </div>
                </div>
                <StateChip state={p.state} expiresAt={p.expiresAt} />
              </div>
              {canCreate && (
                <button type="button" onClick={() => regenerate(p.affiliate.id)} disabled={rowBusy === p.affiliate.id} data-regenerate={p.affiliate.username ?? ""}
                  className={`${ui.btnPrimary} w-full sm:w-auto`}>
                  <KeyRound className="w-4 h-4" aria-hidden="true" />
                  {rowBusy === p.affiliate.id ? t("common_creating") : t("act_new_code")}
                </button>
              )}
              {rowError[p.affiliate.id] && <p role="alert" className="text-xs text-red-700" data-row-error>{recruiterErrorLabel(rowError[p.affiliate.id], lang)}</p>}
              {issued[p.affiliate.id] && <ActivationCodeCard activation={issued[p.affiliate.id]} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
