"use client";
/**
 * /recruiter/network/stats — statistics of the recruiter's network (Affiliate Recruiter
 * System, Phase 4). Arabic, RTL, READ ONLY. Real database counts only.
 *
 *   • GET /api/recruiter/network/stats?rootId=            → totals, identity, orders, levels
 *   • GET /api/recruiter/network/nodes?parentId=&limit=1  → breadcrumb of a sub-network
 * `?root=<id>` scopes everything to the sub-network of one of the recruiter's own affiliates.
 * Phase 7 Stage B/C: levels are ABSOLUTE everywhere (the tree, its breadcrumb and these statistics,
 * whole network or sub-network): level 1 = a top affiliate of the recruiter's network. Fake orders
 * are always reported apart and are never counted as real delivered sales. A stale answer (root
 * changed meanwhile) is discarded; creation buttons only when /api/recruiter/me allows them.
 * Phase 6 part 4: `orders: null` (order visibility turned off by the admin) → the order section
 * and the per-level order columns are not shown (never zeros); a note explains why.
 * Rendered inside the recruiter app shell (RecruiterShell): no own header / <main>, the shared UI kit;
 * the tables scroll inside their card, never the page.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Layers, Package, ShieldCheck, UserPlus, Users } from "lucide-react";
import { toRecruiterNetworkPathView, toRecruiterNetworkStatsView } from "@/lib/recruiterVisibility";
import {
  Breadcrumb, ErrorBox, FAKE_LABEL, FigureTile, IDENTITY_KEYS, IDENTITY_LABEL, Loading, NetworkHeader, ORDER_KEYS, ORDER_LABEL, PageNotice,
  OrdersHidden, fmt, getJson, handleAuth, useRecruiterPerms,
} from "../networkUi";
import { createRequestGate, levelLabel } from "../../recruiterUiState";
import { Card, CardTitle, EmptyState, LoadingBlock, ui } from "../../_components/ui";

/** One card of the page (shell Card + CardTitle with a lucide icon). */
function Section({ title, Icon, children, ...rest }) {
  return (
    <Card className={`${ui.cardPad} space-y-4`} {...rest}>
      <CardTitle Icon={Icon} title={title} />
      {children}
    </Card>
  );
}

function NetworkStats() {
  const router = useRouter();
  const root = useSearchParams().get("root") || null;
  const [notice, setNotice] = useState("");
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [path, setPath] = useState([]);
  const gate = useRef(createRequestGate()).current;
  const { permsError, retryPerms, canCreate } = useRecruiterPerms(router, setNotice);

  const load = useCallback(async () => {
    const token = gate.begin();
    setError(null); setStats(null); setPath([]);
    const [s, p] = await Promise.all([
      getJson(`/api/recruiter/network/stats${root ? `?rootId=${encodeURIComponent(root)}` : ""}`),
      root ? getJson(`/api/recruiter/network/nodes?${new URLSearchParams({ parentId: root, limit: "1" }).toString()}`) : Promise.resolve(null),
    ]);
    if (!gate.isCurrent(token)) return; // the root changed meanwhile: stale answer
    if (handleAuth(s, router, setNotice) || (p && handleAuth(p, router, setNotice))) return;
    if (!s.ok) { setError(s.code); return; }
    setStats(toRecruiterNetworkStatsView(s.body?.stats));
    setPath(p?.ok ? (p.body?.path ?? []).map(toRecruiterNetworkPathView) : []);
  }, [root, router, gate]);

  useEffect(() => { load(); }, [load]);

  if (notice) return <PageNotice text={notice} />;

  const current = root && path.length ? path[path.length - 1] : null;
  const title = root ? `إحصائيات شبكة ${current?.name || current?.username || "الأفلييت"}` : "إحصائيات شبكتي";
  const t = stats?.totals;
  return (
    <div className="space-y-5 sm:space-y-6 min-w-0 [contain:inline-size]" data-recruiter-network-stats>
      <NetworkHeader title={title} current="stats" root={root} />
      {root && (
        <div className={`${ui.card} px-4 sm:px-5 py-1 flex flex-wrap items-center justify-between gap-x-4`}>
          {path.length > 0 && <Breadcrumb path={path} base="/recruiter/network/stats" />}
          <Link href="/recruiter/network/stats" className={`inline-flex items-center min-h-11 text-sm ${ui.link}`} data-full-network>
            إحصائيات الشبكة كاملة ‹
          </Link>
        </div>
      )}

      {permsError && <ErrorBox code={permsError} onRetry={retryPerms} />}
      {error ? <ErrorBox code={error} onRetry={load} /> : !stats ? <Loading /> : t.affiliates === 0 ? (
        <Card className={ui.cardPad} data-empty>
          <EmptyState Icon={Users} text={root ? "لا يوجد أفلييت تحت هذا الحساب." : "لا يوجد أفلييت في شبكتك بعد"}>
            {!root && canCreate && <Link href="/recruiter/affiliates/new" className={`mt-1 ${ui.btnPrimary}`} data-empty-create><UserPlus className="w-4 h-4" aria-hidden="true" />إنشاء أفلييت</Link>}
          </EmptyState>
        </Card>
      ) : (
        <>
          <Section title="المجموع" Icon={Users} data-totals>
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
              <FigureTile label="عدد الأفلييت" value={t.affiliates} attrs={{ "data-stats-total": "" }} />
              <FigureTile label={root ? "المباشرون تحت هذا الحساب" : "الأفلييت الرئيسيون (المستوى 1)"} value={t.direct} attrs={{ "data-stats-direct": "" }} />
              <FigureTile label="أعمق مستوى" value={t.maxLevel} attrs={{ "data-stats-max-level": "" }} />
              <FigureTile label="مفعّلون" value={t.active} tone="green" attrs={{ "data-stats-active": "" }} />
              <FigureTile label="غير مفعّلين" value={t.inactive} tone="slate" attrs={{ "data-stats-inactive": "" }} />
              {t.unplaced > 0 && <FigureTile label="بدون موقع صالح (بيانات غير متناسقة)" value={t.unplaced} tone="amber" attrs={{ "data-unplaced": "" }} />}
            </dl>
          </Section>

          <Section title="التحقق من البطاقة الوطنية" Icon={ShieldCheck} data-identity>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
              {IDENTITY_KEYS.map((k) => <FigureTile key={k} label={IDENTITY_LABEL[k]} value={stats.identity[k]} attrs={{ "data-identity-count": k }}
                tone={k === "APPROVED" ? "green" : k === "PENDING" ? "amber" : "slate"} />)}
            </dl>
          </Section>

          {!stats.orders ? (
            <Section title="تتبّع الطلبات" Icon={Package} data-orders>
              <OrdersHidden />
            </Section>
          ) : (
          <Section title="تتبّع الطلبات" Icon={Package} data-orders>
            <p className="text-xs leading-relaxed text-violet-800 bg-violet-50 border border-violet-200 rounded-2xl px-3.5 py-2.5" data-fake-note>
              الطلبات التجريبية تظهر منفصلة ولا تُحتسب أبداً ضمن الطلبات الحقيقية المسلّمة.
            </p>
            <dl className="grid grid-cols-2 gap-2 sm:gap-3">
              <FigureTile label="طلبات حقيقية مسلّمة" value={stats.orders.real.delivered} tone="green" attrs={{ "data-real-delivered": "" }} />
              <FigureTile label="طلبات حقيقية غير مسلّمة" value={stats.orders.real.total - stats.orders.real.delivered} tone="slate" attrs={{ "data-real-not-delivered": "" }} />
            </dl>
            <div className={ui.tableWrap}>
              <table className="w-full">
                <thead>
                  <tr>
                    <th scope="col" className={ui.th}>الحالة</th>
                    <th scope="col" className={ui.th}>حقيقية</th>
                    <th scope="col" className={ui.th}>{FAKE_LABEL}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-violet-50">
                  {ORDER_KEYS.map((k) => (
                    <tr key={k} data-order-row={k}>
                      <th scope="row" className={`${ui.td} text-start font-normal whitespace-nowrap`}>{ORDER_LABEL[k]}</th>
                      <td className={`${ui.td} font-semibold ${k === "delivered" ? "text-emerald-700" : ""}`} data-real={k}>{fmt(stats.orders.real[k])}</td>
                      <td className={`${ui.td} text-violet-700`} data-fake={k}>{fmt(stats.orders.fake[k])}</td>
                    </tr>
                  ))}
                  <tr className="bg-violet-50/60 font-bold">
                    <th scope="row" className={`${ui.td} text-start text-slate-900`}>المجموع</th>
                    <td className={`${ui.td} text-slate-900`} data-real="total">{fmt(stats.orders.real.total)}</td>
                    <td className={`${ui.td} text-violet-700`} data-fake-total="">{fmt(stats.orders.fake.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>
          )}

          <Section title="حسب المستوى" Icon={Layers} data-levels>
            <p className={ui.hint} data-levels-note>
              المستويات نفسها في الشجرة والإحصائيات: المستوى 1 = الأفلييت الرئيسيون في شبكتك{root ? "، حتى داخل شبكة فرعية" : ""}.
            </p>
            <div className={ui.tableWrap} data-levels-scroll>
              <table className="min-w-[44rem] w-full">
                <thead>
                  <tr>
                    {["المستوى", "الأفلييت", "مفعّلون", "غير مفعّلين", ...IDENTITY_KEYS.map((k) => `البطاقة: ${IDENTITY_LABEL[k]}`), ...(stats.orders ? ["حقيقية مسلّمة", "حقيقية غير مسلّمة", "تجريبية"] : [])].map((h) => (
                      <th key={h} scope="col" className={ui.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-violet-50">
                  {stats.levels.map((l) => (
                    <tr key={l.level} data-level-row={l.level}>
                      <th scope="row" className={`${ui.td} text-start font-bold text-violet-700 whitespace-nowrap`} data-level-label>{levelLabel(l.level)}</th>
                      <td className={`${ui.td} font-semibold text-slate-900`} data-level-affiliates>{fmt(l.affiliates)}</td>
                      <td className={ui.td}>{fmt(l.active)}</td>
                      <td className={ui.td}>{fmt(l.inactive)}</td>
                      {IDENTITY_KEYS.map((k) => <td key={k} className={ui.td}>{fmt(l.identity[k])}</td>)}
                      {l.orders && (
                        <>
                          <td className={`${ui.td} font-semibold text-emerald-700`} data-level-real-delivered>{fmt(l.orders.real.delivered)}</td>
                          <td className={ui.td}>{fmt(l.orders.real.total - l.orders.real.delivered)}</td>
                          <td className={`${ui.td} text-violet-700`} data-level-fake>{fmt(l.orders.fake.total)}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

export default function RecruiterNetworkStatsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <NetworkStats />
    </Suspense>
  );
}
