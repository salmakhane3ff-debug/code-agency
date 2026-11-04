"use client";
/**
 * /recruiter/network/stats — statistics of the recruiter's network (Affiliate Recruiter
 * System, Phase 4). Arabic, RTL, READ ONLY. Real database counts only.
 *
 *   • GET /api/recruiter/network/stats?rootId=            → totals, identity, orders, levels
 *   • GET /api/recruiter/network/nodes?parentId=&limit=1  → breadcrumb of a sub-network
 * `?root=<id>` scopes everything to the sub-network of one of the recruiter's own affiliates
 * (levels are then relative to it: level 1 = its direct affiliates). Fake orders are always
 * reported apart and are never counted as real delivered sales.
 */
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toRecruiterNetworkPathView, toRecruiterNetworkStatsView } from "@/lib/recruiterVisibility";
import {
  Breadcrumb, ErrorBox, FAKE_LABEL, IDENTITY_KEYS, IDENTITY_LABEL, Loading, NetworkHeader, ORDER_KEYS, ORDER_LABEL, PageNotice,
  fmt, getJson, handleAuth,
} from "../networkUi";

function Card({ label, value, attrs = {}, tone = "slate" }) {
  const tones = { slate: "bg-white border-slate-200", green: "bg-emerald-50 border-emerald-200", violet: "bg-violet-50 border-violet-200", amber: "bg-amber-50 border-amber-200" };
  return (
    <div className={`rounded-2xl border p-3 min-w-0 ${tones[tone]}`}>
      <dt className="text-xs text-slate-500 leading-tight">{label}</dt>
      <dd className="text-xl font-bold text-slate-900 mt-1" {...attrs}>{fmt(value)}</dd>
    </div>
  );
}

function Section({ title, children, ...rest }) {
  return (
    <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 space-y-3 min-w-0" {...rest}>
      <h2 className="text-base font-bold">{title}</h2>
      {children}
    </section>
  );
}

function NetworkStats() {
  const router = useRouter();
  const root = useSearchParams().get("root") || null;
  const [notice, setNotice] = useState("");
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [path, setPath] = useState([]);

  const load = useCallback(async () => {
    setError(null); setStats(null);
    const [s, p] = await Promise.all([
      getJson(`/api/recruiter/network/stats${root ? `?rootId=${encodeURIComponent(root)}` : ""}`),
      root ? getJson(`/api/recruiter/network/nodes?${new URLSearchParams({ parentId: root, limit: "1" }).toString()}`) : Promise.resolve(null),
    ]);
    if (handleAuth(s, router, setNotice) || (p && handleAuth(p, router, setNotice))) return;
    if (!s.ok) { setError(s.code); return; }
    setStats(toRecruiterNetworkStatsView(s.body?.stats));
    setPath(p?.ok ? (p.body?.path ?? []).map(toRecruiterNetworkPathView) : []);
  }, [root, router]);

  useEffect(() => { load(); }, [load]);

  if (notice) return <PageNotice text={notice} />;

  const current = root && path.length ? path[path.length - 1] : null;
  const title = root ? `إحصائيات شبكة ${current?.name || current?.username || "الأفلييت"}` : "إحصائيات شبكتي";
  const t = stats?.totals;
  return (
    <div className="min-h-screen [contain:inline-size]" data-recruiter-network-stats>
      <NetworkHeader title={title} current="stats" root={root} />
      <main className="max-w-4xl mx-auto p-4 sm:p-6 space-y-4 min-w-0">
        {root && path.length > 0 && <Breadcrumb path={path} base="/recruiter/network/stats" />}
        {root && (
          <Link href="/recruiter/network/stats" className="inline-block text-sm font-semibold text-emerald-700 hover:underline" data-full-network>
            إحصائيات الشبكة كاملة ‹
          </Link>
        )}

        {error ? <ErrorBox code={error} onRetry={load} /> : !stats ? <Loading /> : t.affiliates === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-6 text-center space-y-3" data-empty>
            <p className="text-sm text-slate-600">{root ? "لا يوجد أفلييت تحت هذا الحساب." : "لا يوجد أفلييت في شبكتك بعد"}</p>
            {!root && <Link href="/recruiter/affiliates/new" className="inline-block rounded-xl bg-emerald-600 text-white font-bold px-4 py-2" data-empty-create>إنشاء أفلييت</Link>}
          </div>
        ) : (
          <>
            <Section title="المجموع" data-totals>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <Card label="عدد الأفلييت" value={t.affiliates} attrs={{ "data-stats-total": "" }} />
                <Card label={root ? "المباشرون تحت هذا الحساب" : "الأفلييت المباشرون (المستوى 1)"} value={t.direct} attrs={{ "data-stats-direct": "" }} />
                <Card label="أعمق مستوى" value={t.maxLevel} attrs={{ "data-stats-max-level": "" }} />
                <Card label="مفعّلون" value={t.active} tone="green" attrs={{ "data-stats-active": "" }} />
                <Card label="غير مفعّلين" value={t.inactive} attrs={{ "data-stats-inactive": "" }} />
                {t.unplaced > 0 && <Card label="بدون موقع صالح (بيانات غير متناسقة)" value={t.unplaced} tone="amber" attrs={{ "data-unplaced": "" }} />}
              </dl>
            </Section>

            <Section title="التحقق من البطاقة الوطنية" data-identity>
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {IDENTITY_KEYS.map((k) => <Card key={k} label={IDENTITY_LABEL[k]} value={stats.identity[k]} attrs={{ "data-identity-count": k }} />)}
              </dl>
            </Section>

            <Section title="تتبّع الطلبات" data-orders>
              <p className="text-xs text-violet-800 bg-violet-50 border border-violet-200 rounded-xl px-3 py-2" data-fake-note>
                الطلبات التجريبية تظهر منفصلة ولا تُحتسب أبداً ضمن الطلبات الحقيقية المسلّمة.
              </p>
              <dl className="grid grid-cols-2 gap-2">
                <Card label="طلبات حقيقية مسلّمة" value={stats.orders.real.delivered} tone="green" attrs={{ "data-real-delivered": "" }} />
                <Card label="طلبات حقيقية غير مسلّمة" value={stats.orders.real.total - stats.orders.real.delivered} attrs={{ "data-real-not-delivered": "" }} />
              </dl>
              <div className="overflow-x-auto max-w-full rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th scope="col" className="text-start font-semibold px-3 py-2">الحالة</th>
                      <th scope="col" className="text-start font-semibold px-3 py-2">حقيقية</th>
                      <th scope="col" className="text-start font-semibold px-3 py-2">{FAKE_LABEL}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {ORDER_KEYS.map((k) => (
                      <tr key={k} data-order-row={k}>
                        <th scope="row" className="text-start font-normal px-3 py-2">{ORDER_LABEL[k]}</th>
                        <td className="px-3 py-2 font-semibold" data-real={k}>{fmt(stats.orders.real[k])}</td>
                        <td className="px-3 py-2 text-violet-700" data-fake={k}>{fmt(stats.orders.fake[k])}</td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 font-bold">
                      <th scope="row" className="text-start px-3 py-2">المجموع</th>
                      <td className="px-3 py-2" data-real="total">{fmt(stats.orders.real.total)}</td>
                      <td className="px-3 py-2 text-violet-700" data-fake-total="">{fmt(stats.orders.fake.total)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Section>

            <Section title={root ? "حسب المستوى (1 = المباشرون تحت هذا الحساب)" : "حسب المستوى"} data-levels>
              <div className="overflow-x-auto max-w-full rounded-xl border border-slate-200" data-levels-scroll>
                <table className="min-w-[44rem] w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      {["المستوى", "الأفلييت", "مفعّلون", "غير مفعّلين", ...IDENTITY_KEYS.map((k) => `البطاقة: ${IDENTITY_LABEL[k]}`), "حقيقية مسلّمة", "حقيقية غير مسلّمة", "تجريبية"].map((h) => (
                        <th key={h} scope="col" className="text-start font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {stats.levels.map((l) => (
                      <tr key={l.level} data-level-row={l.level}>
                        <th scope="row" className="text-start px-3 py-2 font-bold whitespace-nowrap">المستوى {fmt(l.level)}</th>
                        <td className="px-3 py-2" data-level-affiliates>{fmt(l.affiliates)}</td>
                        <td className="px-3 py-2">{fmt(l.active)}</td>
                        <td className="px-3 py-2">{fmt(l.inactive)}</td>
                        {IDENTITY_KEYS.map((k) => <td key={k} className="px-3 py-2">{fmt(l.identity[k])}</td>)}
                        <td className="px-3 py-2 font-semibold text-emerald-700" data-level-real-delivered>{fmt(l.orders.real.delivered)}</td>
                        <td className="px-3 py-2">{fmt(l.orders.real.total - l.orders.real.delivered)}</td>
                        <td className="px-3 py-2 text-violet-700" data-level-fake>{fmt(l.orders.fake.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          </>
        )}
      </main>
    </div>
  );
}

export default function RecruiterNetworkStatsPage() {
  return (
    <Suspense fallback={<main className="min-h-screen flex items-center justify-center px-4"><Loading /></main>}>
      <NetworkStats />
    </Suspense>
  );
}
