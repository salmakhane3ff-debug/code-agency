"use client";
/**
 * /recruiter/verification — "التحقق من الهوية" (Affiliate Recruiter System, Phase 6 part 3c).
 * Market language (MA → Arabic RTL, FR → French LTR; errors kept as CODES and rendered in the current language).
 * The recruiter's OWN identity verification (CIN front + back).
 *
 *   • GET  /api/recruiter/identity  → { identity: { status, rejectionReason, submittedAt, reviewedAt, canSubmit } }
 *   • POST /api/recruiter/identity  → multipart { front, back } (first upload, or a new one after a rejection)
 * A withdrawal needs this verification APPROVED (the withdrawal API decides; this page only
 * explains). Client checks (type, 5 MB) are hints: the server checks the real file signature,
 * re-encodes the images and stores them privately. No file key, path, reviewer or stored image
 * is ever received or shown; local previews use object URLs revoked after use.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Clock, IdCard, Loader2, RefreshCw, ShieldAlert, ShieldCheck, Upload, Wallet } from "lucide-react";
import { toRecruiterError, toRecruiterIdentityView } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel, recruiterFieldErrorLabel } from "../errorLabels";
import { authAction } from "../recruiterUiState";
import { Badge, Card, CardTitle, CenteredNotice, PageHeader, ui, useRecruiterLocale } from "../_components/ui";

const ACCEPT = "image/jpeg,image/png,image/webp";
const ACCEPTED = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

function fmtDate(iso, locale) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" }) : "—";
}

const STATUS_UI = {
  NOT_SUBMITTED: { labelKey: "ver_status_not_submitted", tone: "slate", Icon: IdCard },
  PENDING: { labelKey: "identity_pending", tone: "amber", Icon: Clock },
  APPROVED: { labelKey: "ver_status_approved", tone: "green", Icon: ShieldCheck },
  REJECTED: { labelKey: "ver_status_rejected", tone: "red", Icon: ShieldAlert },
};

/** Client hint for one picked file (the server decides): null | FILE_REQUIRED | FILE_TOO_LARGE | INVALID_FILE. */
function localFileError(file) {
  if (!file) return "FILE_REQUIRED";
  if (!ACCEPTED.includes(file.type)) return "INVALID_FILE";
  if (file.size <= 0 || file.size > MAX_BYTES) return "FILE_TOO_LARGE";
  return null;
}

function CinPicker({ side, label, file, preview, error, disabled, onPick }) {
  const { t } = useRecruiterLocale();
  const inputId = `cin-${side}`;
  return (
    <div className="min-w-0 space-y-1.5" data-cin-side={side}>
      <label htmlFor={inputId} className={ui.label}>{label}</label>
      <label htmlFor={inputId}
        className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-3 py-4 text-center cursor-pointer min-h-[9rem] focus-within:ring-2 focus-within:ring-violet-300 ${error ? "border-red-300 bg-red-50/40" : "border-gray-200 bg-gray-50 hover:border-gray-300"} ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}>
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={label} className="max-h-40 w-auto max-w-full rounded-xl object-contain" data-cin-preview={side} />
        ) : (
          <>
            <Upload className="w-6 h-6 text-gray-400" aria-hidden="true" />
            <span className="text-xs text-gray-500">{t("ver_pick_image")}</span>
          </>
        )}
        {file && <bdi className="text-xs text-gray-600 break-all" dir="ltr">{file.name}</bdi>}
      </label>
      <input id={inputId} type="file" accept={ACCEPT} className="sr-only" disabled={disabled}
        onChange={(e) => onPick(e.target.files?.[0] ?? null)} data-cin-input={side} />
      {error && <p className="text-xs text-red-700" role="alert" data-cin-error={side}>{error}</p>}
    </div>
  );
}

export default function RecruiterVerificationPage() {
  const router = useRouter();
  const { t, lang, intlLocale } = useRecruiterLocale();
  const aliveRef = useRef(true);
  const [identity, setIdentity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(""); // error CODE
  const [notice, setNotice] = useState(""); // error CODE (RECRUITER_DISABLED)
  const [files, setFiles] = useState({ front: null, back: null });
  const [previews, setPreviews] = useState({ front: "", back: "" });
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // { code } | { field: "body", code }
  const [success, setSuccess] = useState(false);

  const toLogin = useCallback((code) => {
    if (code === "RECRUITER_DISABLED") {
      setNotice(code);
      setTimeout(() => { if (aliveRef.current) router.replace("/recruiter/login"); }, 2500);
    } else {
      router.replace("/recruiter/login");
    }
  }, [router]);
  const authGate = useCallback((res, err) => {
    const action = authAction(res.status, err.code); // ONLY 401 / 403 RECRUITER_DISABLED
    if (action) {
      toLogin(action === "disabled" ? err.code : "UNAUTHORIZED");
      return true;
    }
    return false;
  }, [toLogin]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch("/api/recruiter/identity", { credentials: "include", cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!aliveRef.current) return;
      if (!res.ok) {
        const err = toRecruiterError(body);
        if (authGate(res, err)) return;
        setLoadError(err.code);
        return;
      }
      setIdentity(toRecruiterIdentityView(body?.identity));
    } catch {
      if (aliveRef.current) setLoadError("SERVER_ERROR");
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [authGate]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => { aliveRef.current = false; };
  }, [load]);

  // Object URLs of the local previews are revoked when replaced and on unmount.
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  useEffect(() => () => { for (const u of Object.values(previewsRef.current)) if (u) URL.revokeObjectURL(u); }, []);

  const pick = (side, file) => {
    setFiles((f) => ({ ...f, [side]: file }));
    setPreviews((p) => {
      if (p[side]) URL.revokeObjectURL(p[side]);
      return { ...p, [side]: file && ACCEPTED.includes(file.type) ? URL.createObjectURL(file) : "" };
    });
    setFieldErrors((fe) => { const n = { ...fe }; delete n[side]; return n; });
    setError(null);
    setSuccess(false);
  };

  async function submit(e) {
    e.preventDefault();
    if (busy || !identity?.canSubmit) return;
    const local = {};
    for (const side of ["front", "back"]) { const c = localFileError(files[side]); if (c) local[side] = c; }
    if (Object.keys(local).length) { setFieldErrors(local); return; }
    setBusy(true);
    setError(null);
    setSuccess(false);
    try {
      const fd = new FormData();
      fd.append("front", files.front);
      fd.append("back", files.back);
      const res = await fetch("/api/recruiter/identity", { method: "POST", credentials: "include", cache: "no-store", body: fd });
      const body = await res.json().catch(() => null);
      if (!aliveRef.current) return;
      if (res.ok) {
        setIdentity(toRecruiterIdentityView(body?.identity));
        pick("front", null);
        pick("back", null);
        setSuccess(true);
        return;
      }
      const err = toRecruiterError(body);
      if (authGate(res, err)) return;
      if (err.fields) setFieldErrors(err.fields);
      setError(err.fields?.body ? { field: "body", code: err.fields.body } : { code: err.code });
      if (err.code === "IDENTITY_SUBMISSION_NOT_ALLOWED") await load();
    } catch {
      setError({ code: "SERVER_ERROR" });
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  if (notice) {
    return <CenteredNotice hook="data-page-notice">{recruiterErrorLabel(notice, lang)}</CenteredNotice>;
  }

  const st = STATUS_UI[identity?.status] ?? STATUS_UI.NOT_SUBMITTED;
  const fieldMsg = (side) => (fieldErrors[side] ? recruiterFieldErrorLabel(side, fieldErrors[side], lang) : "");
  const errorText = !error ? "" : error.field ? recruiterFieldErrorLabel(error.field, error.code, lang) : recruiterErrorLabel(error.code, lang);

  return (
    <div className="space-y-5 min-w-0" data-recruiter-verification>
      <PageHeader Icon={ShieldCheck} title={t("nav_verification")} />

      <div className="max-w-3xl space-y-4 min-w-0">
        <p className={ui.hint}>
          {t("ver_intro")}
        </p>

        {loading && !identity && (
          <p className="flex items-center gap-2 text-sm text-gray-500" aria-live="polite" data-loading><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> {t("common_loading")}</p>
        )}
        {loadError && (
          <div role="alert" className="rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center gap-3 justify-between" data-error>
            <span className="min-w-0">{recruiterErrorLabel(loadError, lang)}</span>
            <button type="button" onClick={load} data-retry
              className="shrink-0 inline-flex items-center gap-1.5 min-h-10 rounded-xl border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-100">
              <RefreshCw className="w-4 h-4" aria-hidden="true" /> {t("common_retry")}
            </button>
          </div>
        )}

        {identity && (
          <Card className={`${ui.cardPad} space-y-3`} aria-labelledby="st-title" data-identity-status={identity.status}>
            <CardTitle Icon={IdCard} id="st-title" title={t("ver_status_title")} />
            <Badge tone={st.tone}>
              <st.Icon className="w-4 h-4 shrink-0" aria-hidden="true" /> {t(st.labelKey)}
            </Badge>
            {identity.submittedAt && <p className={ui.hint}>{t("ver_submitted_at")} <bdi>{fmtDate(identity.submittedAt, intlLocale)}</bdi></p>}
            {identity.status === "PENDING" && (
              <p className="rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-sm text-amber-700" data-identity-pending>{t("ver_pending")}</p>
            )}
            {identity.status === "APPROVED" && (
              <p className="text-sm text-green-700 flex items-start gap-2" data-identity-approved>
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span className="min-w-0">
                  {identity.reviewedAt ? <>{t("ver_approved_on")} <bdi>{fmtDate(identity.reviewedAt, intlLocale)}</bdi>.</> : `${t("ver_approved")}.`}
                  {" "}{t("ver_approved_next")}
                </span>
              </p>
            )}
            {identity.status === "REJECTED" && (
              <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700 space-y-1" data-identity-rejected>
                <p className="font-semibold">{t("ver_rejected")}</p>
                {identity.rejectionReason && (
                  <p className="break-words" data-rejection-reason>{t("ver_reason")} <bdi>{identity.rejectionReason}</bdi></p>
                )}
              </div>
            )}
            <div>
              <Link href="/recruiter/wallet" className={ui.btnSecondary} data-wallet-link>
                <Wallet className="w-4 h-4" aria-hidden="true" /> {t("ver_wallet_link")}
              </Link>
            </div>
          </Card>
        )}

        {identity?.canSubmit && (
          <Card className={ui.cardPad}>
            <form onSubmit={submit} noValidate className="space-y-4 min-w-0" data-identity-form>
              <CardTitle Icon={Upload} title={identity.status === "REJECTED" ? t("ver_send_new") : t("ver_send_card")} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 min-w-0">
                <CinPicker side="front" label={t("ver_front")} file={files.front} preview={previews.front}
                  error={fieldMsg("front")} disabled={busy} onPick={(f) => pick("front", f)} />
                <CinPicker side="back" label={t("ver_back")} file={files.back} preview={previews.back}
                  error={fieldMsg("back")} disabled={busy} onPick={(f) => pick("back", f)} />
              </div>
              <button type="submit" disabled={busy || !files.front || !files.back} data-identity-submit className={`${ui.btnPrimary} w-full sm:w-auto px-5`}>
                {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                {busy ? t("common_sending") : t("ver_submit")}
              </button>
            </form>
          </Card>
        )}

        {/* Stage C: outside the form, so it stays visible when the refreshed status hides the form
            (e.g. IDENTITY_SUBMISSION_NOT_ALLOWED: already pending or approved meanwhile). */}
        {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2" data-identity-error>{errorText}</p>}

        {success && (
          <p role="status" className="flex items-start gap-2 rounded-xl border border-green-100 bg-green-50 p-4 text-sm text-green-700" data-identity-success>
            <CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t("ver_success")}</span>
          </p>
        )}
      </div>
    </div>
  );
}
