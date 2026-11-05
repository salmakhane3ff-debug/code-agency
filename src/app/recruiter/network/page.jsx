"use client";
/**
 * /recruiter/network — the recruiter's network tree (Affiliate Recruiter System, Phase 4).
 * Arabic, RTL, READ ONLY.
 *
 *   • GET /api/recruiter/network/stats?rootId=            → summary strip of the current scope
 *   • GET /api/recruiter/network/nodes?parentId=&cursor=  → one page of the tree (lazy branches)
 *   • GET /api/recruiter/network/nodes?view=unplaced      → members no root reaches (malformed data)
 * Unlimited depth: every branch is loaded on demand; the indentation is capped so deep levels
 * never overflow, and the level is shown as a badge. `?root=<id>` shows the sub-network of one
 * of the recruiter's own affiliates (the server refuses any other id: 404 NOT_FOUND).
 * Real and fake orders are always shown apart; a fake order is never a real delivered sale.
 * Phase 6 part 4: when the admin turned off order visibility the server sends `orders: null` —
 * the order counts are then not shown at all (never as zeros) and a short note explains why.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronLeft, Network, UserPlus } from "lucide-react";
import { toRecruiterNetworkNodeView, toRecruiterNetworkPathView, toRecruiterNetworkStatsView } from "@/lib/recruiterVisibility";
import {
  Breadcrumb, Chip, ErrorBox, FAKE_LABEL, IDENTITY_LABEL, Loading, NetworkHeader, ORDER_KEYS, ORDER_LABEL, OrdersHidden, PageNotice,
  STATUS_LABEL, fmt, getJson, handleAuth, identityTone,
} from "./networkUi";

const PAGE = 50;
const nodesUrl = (params) => `/api/recruiter/network/nodes?${new URLSearchParams(params).toString()}`;

/** Summary of the current scope (whole network or one sub-network). */
function SummaryStrip({ stats, root }) {
  const t = stats.totals;
  const items = [
    ["الأفلييت", t.affiliates, { "data-stats-total": "" }],
    [root ? "المباشرون تحته" : "المباشرون", t.direct, {}],
    ["مفعّلون", t.active, {}],
    ["غير مفعّلين", t.inactive, {}],
    ...(stats.orders ? [
      ["طلبات مسلّمة حقيقية", stats.orders.real.delivered, { "data-real-delivered": "" }],
      ["طلبات تجريبية مسلّمة (غير محتسبة)", stats.orders.fake.delivered, { "data-fake-total": "" }],
    ] : []),
  ];
  return (
    <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 space-y-3" data-summary aria-label="ملخص الشبكة">
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {items.map(([label, value, attrs]) => (
          <div key={label} className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 min-w-0">
            <dt className="text-[11px] text-slate-500 leading-tight">{label}</dt>
            <dd className="text-lg font-bold text-slate-900" {...attrs}>{fmt(value)}</dd>
          </div>
        ))}
      </dl>
      {!stats.orders && <OrdersHidden />}
      <Link href={`/recruiter/network/stats${root ? `?root=${encodeURIComponent(root)}` : ""}`} className="inline-block text-sm font-semibold text-emerald-700 hover:underline" data-stats-link>
        عرض كل الإحصائيات ‹
      </Link>
    </section>
  );
}

/** Order counts of one affiliate: REAL by status, FAKE apart (never added to real). */
function NodeOrders({ orders }) {
  if (!orders) return null; // order visibility turned off by the admin: nothing, never zeros
  const real = orders.real;
  const shown = ORDER_KEYS.filter((k) => k === "delivered" || real[k] > 0);
  return (
    <div className="flex flex-wrap items-center gap-1.5 min-w-0" data-node-orders>
      <span className="text-[11px] text-slate-500">الطلبات الحقيقية:</span>
      {shown.map((k) => (
        <Chip key={k} tone={k === "delivered" ? "green" : k === "cancelled" || k === "returned" ? "red" : "slate"}
          {...(k === "delivered" ? { "data-real-delivered": "" } : { "data-real-status": k })}>
          {ORDER_LABEL[k]}: {fmt(real[k])}
        </Chip>
      ))}
      <Chip tone="violet" data-fake-total="">{FAKE_LABEL}: {fmt(orders.fake.total)}</Chip>
    </div>
  );
}

function NodeCard({ node, open, onToggle, unplaced }) {
  const hasChildren = node.childrenCount > 0;
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-2 min-w-0" data-node-id={node.id} data-node-level={node.level ?? ""}>
      <div className="flex items-start gap-2 min-w-0">
        {hasChildren ? (
          <button type="button" onClick={onToggle} aria-expanded={open} data-expand
            aria-label={open ? "إخفاء الفروع" : "إظهار الفروع"}
            className="shrink-0 mt-0.5 rounded-lg p-1 text-slate-600 hover:bg-slate-100">
            {open ? <ChevronDown className="w-4 h-4" aria-hidden="true" /> : <ChevronLeft className="w-4 h-4" aria-hidden="true" />}
          </button>
        ) : <span className="shrink-0 w-6" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <p className="font-bold text-sm truncate" data-node-name>{node.name || "—"}</p>
          <p className="text-xs text-slate-500 truncate" dir="ltr" data-node-username>{node.username || "—"}</p>
        </div>
        <Chip tone="slate" data-level-badge>{node.level ? `المستوى ${fmt(node.level)}` : "بدون مستوى"}</Chip>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={node.status === "ACTIVE" ? "green" : node.status === "INACTIVE" ? "red" : "slate"} data-node-status={node.status ?? ""}>
          {STATUS_LABEL[node.status] ?? "غير محدد"}
        </Chip>
        <Chip tone={identityTone(node.identityStatus)} data-node-identity={node.identityStatus}>
          البطاقة الوطنية: {IDENTITY_LABEL[node.identityStatus]}
        </Chip>
        {!unplaced && (
          <span className="text-[11px] text-slate-500" data-node-counts>
            الأبناء المباشرون: {fmt(node.childrenCount)} · كل الفروع: {fmt(node.descendantsCount)}
          </span>
        )}
      </div>
      <NodeOrders orders={node.orders} />
      {hasChildren && !unplaced && (
        <Link href={`/recruiter/network?root=${encodeURIComponent(node.id)}`} data-subnetwork-link
          className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:underline">
          <Network className="w-3.5 h-3.5" aria-hidden="true" />
          عرض شبكته
        </Link>
      )}
    </div>
  );
}

/**
 * A list of nodes (one level) + their open branches. `indent` is the RELATIVE depth in this
 * view; the visual indent stops at 4 steps so any depth fits on a 360 px screen.
 */
function Branch({ list, branches, toggle, loadMore, indent, unplaced = false }) {
  return (
    <ul className={`space-y-2 min-w-0 ${indent > 0 && indent <= 4 ? "ps-3 border-s-2 border-emerald-100" : ""}`}>
      {list.nodes.map((n) => {
        const b = branches[n.id];
        return (
          <li key={n.id} className="space-y-2 min-w-0">
            <NodeCard node={n} open={!!b?.open} onToggle={() => toggle(n.id)} unplaced={unplaced} />
            {b?.open && (
              <div className="min-w-0">
                {b.nodes.length > 0 && <Branch list={b} branches={branches} toggle={toggle} loadMore={loadMore} indent={indent + 1} />}
                {b.loading && <Loading />}
                {b.error && <ErrorBox code={b.error} onRetry={() => loadMore(n.id)} />}
                {!b.loading && !b.error && b.nextCursor !== null && (
                  <button type="button" onClick={() => loadMore(n.id)} data-load-more
                    className="mt-2 rounded-xl border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">تحميل المزيد</button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function NetworkTree() {
  const router = useRouter();
  const root = useSearchParams().get("root") || null;
  const [notice, setNotice] = useState("");
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [top, setTop] = useState({ nodes: [], nextCursor: null, total: 0, loading: true, error: null, path: [] });
  const [branches, setBranches] = useState({});
  const [unplaced, setUnplaced] = useState(null); // { nodes, nextCursor, loading, error }
  const branchesRef = useRef(branches);
  branchesRef.current = branches;

  const fail = useCallback((r) => handleAuth(r, router, setNotice), [router]);

  const loadTop = useCallback(async (cursor = 0) => {
    setTop((t) => ({ ...t, loading: true, error: null }));
    const params = { limit: String(PAGE), cursor: String(cursor), ...(root ? { parentId: root } : {}) };
    const r = await getJson(nodesUrl(params));
    if (fail(r)) return;
    if (!r.ok) { setTop((t) => ({ ...t, loading: false, error: r.code })); return; }
    const nodes = (r.body?.nodes ?? []).map(toRecruiterNetworkNodeView);
    setTop((t) => ({
      nodes: cursor ? [...t.nodes, ...nodes] : nodes,
      nextCursor: Number.isInteger(r.body?.nextCursor) ? r.body.nextCursor : null,
      total: Number.isInteger(r.body?.total) ? r.body.total : 0,
      path: (r.body?.path ?? []).map(toRecruiterNetworkPathView),
      loading: false, error: null,
    }));
  }, [root, fail]);

  const loadStats = useCallback(async () => {
    setStatsError(null);
    const r = await getJson(`/api/recruiter/network/stats${root ? `?rootId=${encodeURIComponent(root)}` : ""}`);
    if (fail(r)) return;
    if (!r.ok) { setStatsError(r.code); return; }
    setStats(toRecruiterNetworkStatsView(r.body?.stats));
  }, [root, fail]);

  useEffect(() => {
    setStats(null); setBranches({}); setUnplaced(null);
    setTop({ nodes: [], nextCursor: null, total: 0, loading: true, error: null, path: [] });
    loadTop(0);
    loadStats();
  }, [loadTop, loadStats]);

  /** Load (the next page of) the children of one node. */
  const loadMore = useCallback(async (id) => {
    const b = branchesRef.current[id] ?? { open: true, nodes: [], nextCursor: 0 };
    const cursor = b.nextCursor ?? 0;
    setBranches((all) => ({ ...all, [id]: { ...b, open: true, loading: true, error: null } }));
    const r = await getJson(nodesUrl({ parentId: id, limit: String(PAGE), cursor: String(cursor) }));
    if (fail(r)) return;
    setBranches((all) => {
      const cur = all[id] ?? b;
      if (!r.ok) return { ...all, [id]: { ...cur, loading: false, error: r.code } };
      const nodes = (r.body?.nodes ?? []).map(toRecruiterNetworkNodeView);
      return {
        ...all,
        [id]: { ...cur, nodes: [...cur.nodes, ...nodes], nextCursor: Number.isInteger(r.body?.nextCursor) ? r.body.nextCursor : null, loading: false, error: null, loaded: true },
      };
    });
  }, [fail]);

  const toggle = useCallback((id) => {
    const b = branchesRef.current[id];
    if (b?.open) { setBranches((all) => ({ ...all, [id]: { ...all[id], open: false } })); return; }
    if (b?.loaded) { setBranches((all) => ({ ...all, [id]: { ...all[id], open: true } })); return; }
    loadMore(id);
  }, [loadMore]);

  const loadUnplaced = useCallback(async (cursor = 0) => {
    setUnplaced((u) => ({ nodes: u?.nodes ?? [], nextCursor: null, loading: true, error: null }));
    const r = await getJson(nodesUrl({ view: "unplaced", limit: String(PAGE), cursor: String(cursor) }));
    if (fail(r)) return;
    if (!r.ok) { setUnplaced((u) => ({ ...u, loading: false, error: r.code })); return; }
    const nodes = (r.body?.nodes ?? []).map(toRecruiterNetworkNodeView);
    setUnplaced((u) => ({ nodes: cursor ? [...(u?.nodes ?? []), ...nodes] : nodes, nextCursor: Number.isInteger(r.body?.nextCursor) ? r.body.nextCursor : null, loading: false, error: null }));
  }, [fail]);

  if (notice) return <PageNotice text={notice} />;

  const current = root && top.path.length ? top.path[top.path.length - 1] : null;
  const title = root ? `شبكة ${current?.name || current?.username || "الأفلييت"}` : "شبكتي";
  return (
    <div className="min-h-screen [contain:inline-size]" data-recruiter-network>
      <NetworkHeader title={title} current="tree" root={root} />
      <main className="max-w-4xl mx-auto p-4 sm:p-6 space-y-4 min-w-0">
        {root && top.path.length > 0 && <Breadcrumb path={top.path} base="/recruiter/network" />}

        {stats ? <SummaryStrip stats={stats} root={root} /> : statsError ? (statsError !== "NOT_FOUND" && <ErrorBox code={statsError} onRetry={loadStats} />) : <Loading />}

        {!root && stats && stats.totals.unplaced > 0 && (
          <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-3 text-sm text-amber-900" data-unplaced>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0">أعضاء بدون موقع صالح في الشجرة (بيانات غير متناسقة): <b>{fmt(stats.totals.unplaced)}</b></p>
              {!unplaced && (
                <button type="button" onClick={() => loadUnplaced(0)} data-unplaced-show
                  className="shrink-0 rounded-xl border border-amber-300 bg-white px-3 py-1.5 font-semibold hover:bg-amber-100">عرض هؤلاء الأعضاء</button>
              )}
            </div>
            {unplaced && (
              <div className="space-y-2" data-unplaced-list>
                {unplaced.nodes.length > 0 && <Branch list={unplaced} branches={{}} toggle={() => {}} loadMore={() => {}} indent={0} unplaced />}
                {unplaced.loading && <Loading />}
                {unplaced.error && <ErrorBox code={unplaced.error} onRetry={() => loadUnplaced(0)} />}
                {!unplaced.loading && unplaced.nextCursor !== null && (
                  <button type="button" onClick={() => loadUnplaced(unplaced.nextCursor)} data-load-more
                    className="rounded-xl border border-amber-300 bg-white px-3 py-1.5 font-semibold">تحميل المزيد</button>
                )}
              </div>
            )}
          </section>
        )}

        <section className="space-y-3 min-w-0" aria-label="شجرة الشبكة" data-tree>
          <h2 className="text-base font-bold">{root ? "الأفلييت تحت هذا الحساب" : "الأفلييت الرئيسيون"}{!top.loading && !top.error && <span className="text-slate-500 font-normal"> ({fmt(top.total)})</span>}</h2>
          {top.error ? (
            <div className="space-y-3">
              <ErrorBox code={top.error} onRetry={() => loadTop(0)} />
              {top.error === "NOT_FOUND" && <Link href="/recruiter/network" className="inline-block text-sm font-semibold text-emerald-700 hover:underline" data-back-network>الرجوع لشبكتي</Link>}
            </div>
          ) : top.nodes.length > 0 ? (
            <Branch list={top} branches={branches} toggle={toggle} loadMore={loadMore} indent={0} />
          ) : !top.loading && (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-6 text-center space-y-3" data-empty>
              <p className="text-sm text-slate-600">{root ? "لا يوجد أفلييت تحت هذا الحساب." : "لا يوجد أفلييت في شبكتك بعد"}</p>
              {!root && (
                <Link href="/recruiter/affiliates/new" className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 text-white font-bold px-4 py-2 hover:bg-emerald-700" data-empty-create>
                  <UserPlus className="w-4 h-4" aria-hidden="true" />
                  إنشاء أفلييت
                </Link>
              )}
            </div>
          )}
          {top.loading && <Loading />}
          {!top.loading && !top.error && top.nextCursor !== null && (
            <button type="button" onClick={() => loadTop(top.nextCursor)} data-load-more
              className="rounded-xl border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">تحميل المزيد</button>
          )}
        </section>
      </main>
    </div>
  );
}

export default function RecruiterNetworkPage() {
  return (
    <Suspense fallback={<main className="min-h-screen flex items-center justify-center px-4"><Loading /></main>}>
      <NetworkTree />
    </Suspense>
  );
}
