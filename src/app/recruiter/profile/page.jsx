"use client";
/**
 * /recruiter/profile — "المزيد" → الملف الشخصي: the recruiter's own account information (the fields of
 * GET /api/recruiter/me — name, username, phone, account status, creation and last login dates, the two
 * permissions set by the admin) and the identity status the app shell already loaded, with links to the existing
 * verification and password pages. Read only. 401 (and 403 RECRUITER_DISABLED with its notice) → login page;
 * other failures → error with a retry.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserRound, ShieldCheck, Lock, ArrowLeft } from "lucide-react";
import { toRecruiterError } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel } from "../errorLabels";
import { authAction, permsFromMe } from "../recruiterUiState";
import { useRecruiterSession } from "../_components/RecruiterAppShell";
import { Badge, CenteredNotice, LoadingBlock, PageHeader, RetryError, Section, ui } from "../_components/ui";

const DATE_FMT = new Intl.DateTimeFormat("ar-MA", { timeZone: "Africa/Casablanca", dateStyle: "medium", timeStyle: "short" });
const fmtDate = (iso) => (iso ? DATE_FMT.format(new Date(iso)) : "—");
const KYC = {
  NOT_SUBMITTED: ["لم تُرسل بعد", "slate"], PENDING: ["قيد المراجعة", "amber"], APPROVED: ["مقبولة", "green"], REJECTED: ["مرفوضة", "red"],
};

function Row({ label, value, ltr = false, hook }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3 border-b border-gray-50 last:border-0 min-w-0">
      <dt className="text-sm text-gray-500 shrink-0">{label}</dt>
      <dd className="text-sm font-semibold text-gray-900 truncate min-w-0" dir={ltr ? "ltr" : undefined} {...(hook ? { [`data-${hook}`]: "" } : {})}>{value}</dd>
    </div>
  );
}

export default function RecruiterProfilePage() {
  const router = useRouter();
  const session = useRecruiterSession();
  const [me, setMe] = useState(null);
  const [perms, setPerms] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState(null);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    setError(null);
    let r;
    try {
      const res = await fetch("/api/recruiter/me", { credentials: "include", cache: "no-store" });
      const body = await res.json().catch(() => null);
      r = res.ok ? { ok: true, status: res.status, code: null, body } : { ok: false, status: res.status, code: toRecruiterError(body).code, body: null };
    } catch {
      r = { ok: false, status: 0, code: "SERVER_ERROR", body: null };
    }
    if (!aliveRef.current) return;
    const action = authAction(r.status, r.code);
    if (action === "login") { router.replace("/recruiter/login"); return; }
    if (action === "disabled") {
      setNotice(recruiterErrorLabel(r.code));
      setTimeout(() => { if (aliveRef.current) router.replace("/recruiter/login"); }, 2500);
      return;
    }
    if (!r.ok || !r.body?.recruiter) { setError(r.code ?? "SERVER_ERROR"); return; }
    setMe(r.body.recruiter);
    setPerms(permsFromMe(r.body));
  }, [router]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => { aliveRef.current = false; };
  }, [load]);

  if (notice) return <CenteredNotice>{notice}</CenteredNotice>;

  const active = me?.status === "ACTIVE";
  const kyc = session?.identity ? KYC[session.identity.status] ?? KYC.NOT_SUBMITTED : null;
  return (
    <div className="space-y-5 max-w-2xl min-w-0" data-recruiter-profile>
      <PageHeader Icon={UserRound} title="الملف الشخصي" subtitle="معلومات حسابك كمسؤول توظيف." />
      {error ? <RetryError code={error} onRetry={load} hook="profile" /> : !me ? <LoadingBlock /> : (
        <>
          <Section Icon={UserRound} title="معلومات الحساب" bodyClass="px-4 sm:px-5 py-1" data-account
            aside={<Badge tone={active ? "green" : "red"} data-account-status>{active ? "مفعّل" : "معطّل"}</Badge>}>
            <dl>
              <Row label="الاسم" value={me.name || "—"} />
              <Row label="اسم المستخدم" value={me.username || "—"} ltr />
              <Row label="الهاتف" value={me.phone || "—"} ltr />
              <Row label="تاريخ الإنشاء" value={fmtDate(me.createdAt)} />
              <Row label="آخر تسجيل دخول" value={fmtDate(me.lastLoginAt)} />
              <Row label="إنشاء أفلييت جدد" value={perms?.canCreateAffiliates ? "مسموح" : "معطّل من طرف الإدارة"} hook="perm-create" />
              <Row label="عرض أرقام الطلبات" value={perms?.canViewOrders ? "مسموح" : "معطّل من طرف الإدارة"} hook="perm-orders" />
            </dl>
          </Section>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Link href="/recruiter/verification" className={`${ui.card} flex items-center gap-3 p-4 min-h-11 hover:border-gray-300`} data-profile-kyc>
              <span className="w-9 h-9 rounded-xl grid place-items-center bg-green-50 text-green-600 shrink-0"><ShieldCheck className="w-[18px] h-[18px]" aria-hidden="true" /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-bold text-gray-900">التحقق من الهوية</span>
                {kyc && <Badge tone={kyc[1]} className="mt-1">{kyc[0]}</Badge>}
              </span>
              <ArrowLeft className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
            </Link>
            <Link href="/recruiter/password" className={`${ui.card} flex items-center gap-3 p-4 min-h-11 hover:border-gray-300`} data-profile-password>
              <span className="w-9 h-9 rounded-xl grid place-items-center bg-gray-100 text-gray-700 shrink-0"><Lock className="w-[18px] h-[18px]" aria-hidden="true" /></span>
              <span className="flex-1 min-w-0 text-sm font-bold text-gray-900">كلمة السر والأمان</span>
              <ArrowLeft className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
