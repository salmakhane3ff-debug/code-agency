"use client";
/**
 * /recruiter/verification — "التحقق من الهوية" (Affiliate Recruiter System, Phase 6 part 3c).
 * Arabic, RTL. The recruiter's OWN identity verification (CIN front + back).
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
import { ArrowRight, CheckCircle2, Clock, IdCard, Loader2, ShieldAlert, ShieldCheck, Upload } from "lucide-react";
import { toRecruiterError, toRecruiterIdentityView } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel, recruiterFieldErrorLabel } from "../errorLabels";

const ACCEPT = "image/jpeg,image/png,image/webp";
const ACCEPTED = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("ar-MA", { year: "numeric", month: "long", day: "numeric" }) : "—";
}

const STATUS_UI = {
  NOT_SUBMITTED: { label: "لم يتم الإرسال بعد", cls: "bg-slate-50 text-slate-700 border-slate-200", Icon: IdCard },
  PENDING: { label: "قيد المراجعة", cls: "bg-amber-50 text-amber-800 border-amber-200", Icon: Clock },
  APPROVED: { label: "تم القبول", cls: "bg-emerald-50 text-emerald-800 border-emerald-200", Icon: ShieldCheck },
  REJECTED: { label: "مرفوض", cls: "bg-red-50 text-red-700 border-red-200", Icon: ShieldAlert },
};

/** Client hint for one picked file (the server decides): null | FILE_REQUIRED | FILE_TOO_LARGE | INVALID_FILE. */
function localFileError(file) {
  if (!file) return "FILE_REQUIRED";
  if (!ACCEPTED.includes(file.type)) return "INVALID_FILE";
  if (file.size <= 0 || file.size > MAX_BYTES) return "FILE_TOO_LARGE";
  return null;
}

function CinPicker({ side, label, file, preview, error, disabled, onPick }) {
  const inputId = `cin-${side}`;
  return (
    <div className="min-w-0 space-y-1.5" data-cin-side={side}>
      <label htmlFor={inputId} className="block text-sm font-semibold">{label}</label>
      <label htmlFor={inputId}
        className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-3 py-4 text-center cursor-pointer min-h-[9rem] ${error ? "border-red-400 bg-red-50/40" : "border-slate-300 hover:bg-slate-50"} ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}>
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={label} className="max-h-40 w-auto max-w-full rounded-lg object-contain" data-cin-preview={side} />
        ) : (
          <>
            <Upload className="w-6 h-6 text-slate-400" aria-hidden="true" />
            <span className="text-xs text-slate-500">اختر صورة (JPG أو PNG أو WEBP، 5 ميغابايت على الأكثر)</span>
          </>
        )}
        {file && <span className="text-xs text-slate-600 break-all" dir="ltr">{file.name}</span>}
      </label>
      <input id={inputId} type="file" accept={ACCEPT} className="sr-only" disabled={disabled}
        onChange={(e) => onPick(e.target.files?.[0] ?? null)} data-cin-input={side} />
      {error && <p className="text-xs text-red-700" role="alert" data-cin-error={side}>{error}</p>}
    </div>
  );
}

export default function RecruiterVerificationPage() {
  const router = useRouter();
  const aliveRef = useRef(true);
  const [identity, setIdentity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [files, setFiles] = useState({ front: null, back: null });
  const [previews, setPreviews] = useState({ front: "", back: "" });
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const toLogin = useCallback((code) => {
    if (code === "RECRUITER_DISABLED") {
      setNotice(recruiterErrorLabel(code));
      setTimeout(() => { if (aliveRef.current) router.replace("/recruiter/login"); }, 2500);
    } else {
      router.replace("/recruiter/login");
    }
  }, [router]);
  const authGate = useCallback((res, err) => {
    if (res.status === 401 || (res.status === 403 && err.code === "RECRUITER_DISABLED")) {
      toLogin(res.status === 403 ? err.code : "UNAUTHORIZED");
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
        setLoadError(recruiterErrorLabel(err.code));
        return;
      }
      setIdentity(toRecruiterIdentityView(body?.identity));
    } catch {
      if (aliveRef.current) setLoadError(recruiterErrorLabel(null));
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
    setError("");
    setSuccess("");
  };

  async function submit(e) {
    e.preventDefault();
    if (busy || !identity?.canSubmit) return;
    const local = {};
    for (const side of ["front", "back"]) { const c = localFileError(files[side]); if (c) local[side] = c; }
    if (Object.keys(local).length) { setFieldErrors(local); return; }
    setBusy(true);
    setError("");
    setSuccess("");
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
        setSuccess("تم إرسال الوثائق. سيتم مراجعتها من طرف الإدارة.");
        return;
      }
      const err = toRecruiterError(body);
      if (authGate(res, err)) return;
      if (err.fields) setFieldErrors(err.fields);
      setError(err.fields?.body ? recruiterFieldErrorLabel("body", err.fields.body) : recruiterErrorLabel(err.code));
      if (err.code === "IDENTITY_SUBMISSION_NOT_ALLOWED") await load();
    } catch {
      setError(recruiterErrorLabel(null));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  if (notice) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <p role="alert" className="max-w-sm text-center text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3" data-page-notice>{notice}</p>
      </main>
    );
  }

  const st = STATUS_UI[identity?.status] ?? STATUS_UI.NOT_SUBMITTED;
  const fieldMsg = (side) => (fieldErrors[side] ? recruiterFieldErrorLabel(side, fieldErrors[side]) : "");

  return (
    <div className="min-h-screen [contain:inline-size]" data-recruiter-verification>
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-2xl mx-auto flex items-center gap-3 px-4 py-3 min-w-0">
          <Link href="/recruiter" className="shrink-0 p-2 -m-2 rounded-lg text-slate-700 hover:bg-slate-100" aria-label="الرجوع للوحة" data-back>
            <ArrowRight className="w-5 h-5" aria-hidden="true" />
          </Link>
          <h1 className="text-base sm:text-lg font-bold truncate">التحقق من الهوية</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 sm:p-6 space-y-4">
        <p className="text-sm text-slate-600">
          لطلب سحب أرباحك، يجب أن تتحقق الإدارة من هويتك عبر صورتي البطاقة الوطنية (الوجه الأمامي والخلفي).
          الصور محفوظة بشكل خاص ولا يطّلع عليها إلا المسؤولون.
        </p>

        {loading && !identity && (
          <p className="flex items-center gap-2 text-sm text-slate-500" data-loading><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> جارٍ التحميل…</p>
        )}
        {loadError && (
          <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center gap-3 justify-between" data-error>
            <span className="min-w-0">{loadError}</span>
            <button type="button" onClick={load} className="rounded-xl border border-red-300 px-3 py-1.5 font-semibold hover:bg-red-100">إعادة المحاولة</button>
          </div>
        )}

        {identity && (
          <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3 min-w-0" aria-labelledby="st-title" data-identity-status={identity.status}>
            <h2 id="st-title" className="text-base font-bold">حالة التحقق</h2>
            <span className={`inline-flex items-center gap-1.5 text-sm font-bold rounded-full border px-3 py-1 ${st.cls}`}>
              <st.Icon className="w-4 h-4 shrink-0" aria-hidden="true" /> {st.label}
            </span>
            {identity.submittedAt && <p className="text-xs text-slate-500">تاريخ الإرسال: {fmtDate(identity.submittedAt)}</p>}
            {identity.status === "PENDING" && (
              <p className="text-sm text-slate-700" data-identity-pending>وثائقك قيد المراجعة من طرف الإدارة. لا يمكن طلب السحب قبل قبولها.</p>
            )}
            {identity.status === "APPROVED" && (
              <p className="text-sm text-emerald-800 flex items-start gap-2" data-identity-approved>
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span className="min-w-0">تم قبول هويتك{identity.reviewedAt ? ` بتاريخ ${fmtDate(identity.reviewedAt)}` : ""}. يمكنك الآن طلب السحب من صفحة أرباحي.</span>
              </p>
            )}
            {identity.status === "REJECTED" && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 space-y-1" data-identity-rejected>
                <p className="font-semibold">تم رفض التحقق. أرسل صوراً جديدة وواضحة للبطاقة.</p>
                {identity.rejectionReason && (
                  <p className="break-words" data-rejection-reason>السبب: <bdi>{identity.rejectionReason}</bdi></p>
                )}
              </div>
            )}
            <Link href="/recruiter/wallet" className="inline-flex text-sm font-bold text-emerald-700 hover:underline" data-wallet-link>أرباحي والسحب</Link>
          </section>
        )}

        {identity?.canSubmit && (
          <form onSubmit={submit} noValidate className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4 min-w-0" data-identity-form>
            <h2 className="text-base font-bold">{identity.status === "REJECTED" ? "إرسال وثائق جديدة" : "إرسال البطاقة الوطنية"}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 min-w-0">
              <CinPicker side="front" label="الوجه الأمامي للبطاقة" file={files.front} preview={previews.front}
                error={fieldMsg("front")} disabled={busy} onPick={(f) => pick("front", f)} />
              <CinPicker side="back" label="الوجه الخلفي للبطاقة" file={files.back} preview={previews.back}
                error={fieldMsg("back")} disabled={busy} onPick={(f) => pick("back", f)} />
            </div>
            {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2" data-identity-error>{error}</p>}
            <button type="submit" disabled={busy || !files.front || !files.back} data-identity-submit
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 text-white font-bold px-5 py-2.5 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed">
              {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              {busy ? "جارٍ الإرسال…" : "إرسال للمراجعة"}
            </button>
          </form>
        )}

        {success && (
          <p role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800" data-identity-success>{success}</p>
        )}
      </main>
    </div>
  );
}
