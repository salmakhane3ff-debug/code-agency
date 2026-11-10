"use client";
/**
 * /recruiter/network/stats — statistics of the recruiter's network (Affiliate Recruiter
 * System, Phase 4). Market language (MA → Arabic RTL, FR → French LTR), READ ONLY. Real database counts only.
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
  Breadcrumb, ErrorBox, FigureTile, IDENTITY_KEY, IDENTITY_KEYS, Loading, NetworkHeader, ORDER_KEY, ORDER_KEYS, PageNotice,
  OrdersHidden, fmt, getJson, handleAuth, useRecruiterPerms,
} from "../networkUi";
import { createRequestGate, levelLabel } from "../../recruiterUiState";
import { Card, EmptyState, LoadingBlock, Section, ui, useRecruiterLocale } from "../../_components/ui";

/** Body of a section (the kit's Section: white card + light title strip). */
const BODY = "p-4 sm:p-5 space-y-4";

function NetworkStats() {
  const router = useRouter();
  const root = useSearchParams().get("root") || null;
  const { t: tr, lang, dir, intlLocale } = useRecruiterLocale();
  const n = (v) => fmt(v, intlLocale);
  const [notice, setNotice] = useState(""); // error CODE (RECRUITER_DISABLED), rendered by PageNotice
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

  if (notice) return <PageNotice code={notice} />;

  const current = root && path.length ? path[path.length - 1] : null;
  const title = root ? tr("stats_title_of", { name: current?.name || current?.username || tr("stats_the_affiliate") }) : tr("stats_title_mine");
  const t = stats?.totals;
  return (
    <div className="space-y-5 min-w-0 [contain:inline-size]" data-recruiter-network-stats>
      <NetworkHeader title={title} current="stats" root={root} />
      {root && (
        <div className={`${ui.card} px-4 sm:px-5 py-1 flex flex-wrap items-center justify-between gap-x-4`}>
          {path.length > 0 && <Breadcrumb path={path} base="/recruiter/network/stats" />}
          <Link href="/recruiter/network/stats" className={`inline-flex items-center min-h-11 text-sm ${ui.link}`} data-full-network>
            {tr("stats_full_network")} {dir === "rtl" ? "‹" : "›"}
          </Link>
        </div>
      )}

      {permsError && <ErrorBox code={permsError} onRetry={retryPerms} />}
      {error ? <ErrorBox code={error} onRetry={load} /> : !stats ? <Loading /> : t.affiliates === 0 ? (
        <Card className={ui.cardPad} data-empty>
          <EmptyState Icon={Users} text={root ? tr("aff_no_children") : tr("aff_empty_network")}>
            {!root && canCreate && <Link href="/recruiter/affiliates/new" className={`mt-1 ${ui.btnPrimary}`} data-empty-create><UserPlus className="w-4 h-4" aria-hidden="true" />{tr("aff_create")}</Link>}
          </EmptyState>
        </Card>
      ) : (
        <>
          <Section title={tr("common_total")} Icon={Users} data-totals bodyClass={BODY}>
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              <FigureTile label={tr("stats_affiliates_count")} value={t.affiliates} attrs={{ "data-stats-total": "" }} />
              <FigureTile label={root ? tr("stats_direct_under") : tr("stats_top_level")} value={t.direct} attrs={{ "data-stats-direct": "" }} />
              <FigureTile label={tr("stats_max_level")} value={t.maxLevel} attrs={{ "data-stats-max-level": "" }} />
              <FigureTile label={tr("stats_active")} value={t.active} tone="green" attrs={{ "data-stats-active": "" }} />
              <FigureTile label={tr("stats_inactive")} value={t.inactive} tone="slate" attrs={{ "data-stats-inactive": "" }} />
              {t.unplaced > 0 && <FigureTile label={tr("stats_unplaced")} value={t.unplaced} tone="amber" attrs={{ "data-unplaced": "" }} />}
            </dl>
          </Section>

          <Section title={tr("stats_identity_title")} Icon={ShieldCheck} data-identity bodyClass={BODY}>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {IDENTITY_KEYS.map((k) => <FigureTile key={k} label={tr(IDENTITY_KEY[k])} value={stats.identity[k]} attrs={{ "data-identity-count": k }}
                tone={k === "APPROVED" ? "green" : k === "PENDING" ? "amber" : "slate"} />)}
            </dl>
          </Section>

          {!stats.orders ? (
            <Section title={tr("stats_orders_title")} Icon={Package} data-orders bodyClass={BODY}>
              <OrdersHidden />
            </Section>
          ) : (
          <Section title={tr("stats_orders_title")} Icon={Package} data-orders bodyClass={BODY}>
            <p className={`${ui.panel} px-3.5 py-2.5 text-xs leading-relaxed text-gray-600`} data-fake-note>
              {tr("stats_fake_note")}
            </p>
            <dl className="grid grid-cols-2 gap-2.5">
              <FigureTile label={tr("stats_real_delivered")} value={stats.orders.real.delivered} tone="green" attrs={{ "data-real-delivered": "" }} />
              <FigureTile label={tr("stats_real_not_delivered")} value={stats.orders.real.total - stats.orders.real.delivered} tone="slate" attrs={{ "data-real-not-delivered": "" }} />
            </dl>
            <div className={ui.tableWrap}>
              <table className="w-full">
                <thead>
                  <tr>
                    <th scope="col" className={ui.th}>{tr("common_status")}</th>
                    <th scope="col" className={ui.th}>{tr("stats_col_real")}</th>
                    <th scope="col" className={ui.th}>{tr("stats_col_fake_full")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {ORDER_KEYS.map((k) => (
                    <tr key={k} data-order-row={k}>
                      <th scope="row" className={`${ui.td} text-start font-normal whitespace-nowrap`}>{tr(ORDER_KEY[k])}</th>
                      <td className={`${ui.td} font-semibold ${k === "delivered" ? "text-green-700" : ""}`} data-real={k}>{n(stats.orders.real[k])}</td>
                      <td className={`${ui.td} text-gray-500`} data-fake={k}>{n(stats.orders.fake[k])}</td>
                    </tr>
                  ))}
                  <tr className="bg-gray-50 font-bold">
                    <th scope="row" className={`${ui.td} text-start text-gray-900`}>{tr("common_total")}</th>
                    <td className={`${ui.td} text-gray-900`} data-real="total">{n(stats.orders.real.total)}</td>
                    <td className={`${ui.td} text-gray-500`} data-fake-total="">{n(stats.orders.fake.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>
          )}

          <Section title={tr("stats_by_level")} Icon={Layers} data-levels bodyClass={BODY}>
            <p className={ui.hint} data-levels-note>
              {root ? tr("stats_levels_note_sub") : tr("stats_levels_note")}
            </p>
            <div className={ui.tableWrap} data-levels-scroll>
              <table className="min-w-[44rem] w-full">
                <thead>
                  <tr>
                    {[tr("stats_col_level"), tr("nav_affiliates"), tr("stats_active"), tr("stats_inactive"), ...IDENTITY_KEYS.map((k) => tr("stats_col_card", { status: tr(IDENTITY_KEY[k]) })),
                      ...(stats.orders ? [tr("stats_col_real_delivered"), tr("stats_col_real_not_delivered"), tr("stats_col_fake")] : [])].map((h) => (
                      <th key={h} scope="col" className={ui.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {stats.levels.map((l) => (
                    <tr key={l.level} data-level-row={l.level}>
                      <th scope="row" className={`${ui.td} text-start font-bold text-gray-900 whitespace-nowrap`} data-level-label>{levelLabel(l.level, lang)}</th>
                      <td className={`${ui.td} font-semibold text-gray-900`} data-level-affiliates>{n(l.affiliates)}</td>
                      <td className={ui.td}>{n(l.active)}</td>
                      <td className={ui.td}>{n(l.inactive)}</td>
                      {IDENTITY_KEYS.map((k) => <td key={k} className={ui.td}>{n(l.identity[k])}</td>)}
                      {l.orders && (
                        <>
                          <td className={`${ui.td} font-semibold text-green-700`} data-level-real-delivered>{n(l.orders.real.delivered)}</td>
                          <td className={ui.td}>{n(l.orders.real.total - l.orders.real.delivered)}</td>
                          <td className={`${ui.td} text-gray-500`} data-level-fake>{n(l.orders.fake.total)}</td>
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
