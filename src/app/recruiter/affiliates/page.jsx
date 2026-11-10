"use client";
/**
 * /recruiter/affiliates — الأفلييت: the recruiter's network in ONE simple card experience (the former flat list and
 * the former tree /recruiter/network merged). Market language (MA → Arabic RTL, FR → French LTR), READ ONLY. Three modes, all in the URL (back / refresh /
 * direct links work; navigation is client-side, never a full reload):
 *   • list     (no query)  GET /api/recruiter/network/nodes?cursor=          → the TOP-LEVEL affiliates of the network
 *                          (+ on demand ?view=unplaced: members on a parent cycle, malformed data)
 *   • search   (?q=)       GET /api/recruiter/affiliates?q=&cursor=          → the whole network, by name / username
 *   • details  (?id=X)     GET /api/recruiter/network/nodes?parentId=X&cursor= → X's own card (parentNode, first page),
 *                          its breadcrumb (path) and its children; every child opens its own details (unlimited depth).
 *                          Anything outside the recruiter's network → 404 NOT_FOUND → a "not in your network" state.
 *   • GET /api/recruiter/me (useRecruiterPerms) → canCreateAffiliates (the creation buttons only).
 * The search is debounced; a stale answer (mode / affiliate / search changed meanwhile) is discarded (request gate);
 * "عرض المزيد" appends the next page without duplicates (mergeById) and its failure keeps the rows already shown.
 * Order figures appear only when the server sends them (canViewOrders) — otherwise "—", never zeros.
 * Built only from recruiterVisibility.js projections. Rendered inside the recruiter app shell (no own header / <main>).
 * Direction: card chevrons and breadcrumb separators point to the END side (left in RTL, right in LTR); names stay
 * in the page direction, @usernames and figures are LTR islands.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Network, Search, TriangleAlert, UserPlus, Users } from "lucide-react";
import { toRecruiterAffiliateListItemView, toRecruiterNetworkNodeView, toRecruiterNetworkPathView } from "@/lib/recruiterVisibility";
import {
  IDENTITY_KEY, STATUS_KEY, fmt, getJson, handleAuth, identityTone, useRecruiterPerms,
} from "../network/networkUi";
import { createRequestGate, levelLabel, mergeById, nodeBadges, progressDisplay } from "../recruiterUiState";
import { recruiterErrorLabel } from "../errorLabels";
import { Badge, Card, CenteredNotice, EmptyState, LoadingBlock, PageHeader, RetryError, ui, useRecruiterLocale } from "../_components/ui";

const BASE = "/recruiter/affiliates";
const NODES_PAGE = 50;
const SEARCH_PAGE = 25;
const QUERY_MAX = 40;
const DEBOUNCE_MS = 300;

const detailsHref = (id) => `${BASE}?id=${encodeURIComponent(id)}`;
const nameOf = (a) => a?.name || a?.username || "—";
/** The chevron that points to the END side (forward / "open"): left in RTL, right in LTR. */
const EndChevron = ({ dir, ...props }) => (dir === "rtl" ? <ChevronLeft {...props} /> : <ChevronRight {...props} />);
const arr = (v) => (Array.isArray(v) ? v : []);
const nodesUrl = (params) => `/api/recruiter/network/nodes?${new URLSearchParams(params).toString()}`;
const pickNodes = (b) => arr(b?.nodes).map(toRecruiterNetworkNodeView);

/** The three paged sources: url(arg, cursor) and pick(body) → { items, nextCursor, head }. */
const SOURCES = {
  nodes: {
    url: (parentId, cursor) => nodesUrl({ limit: String(NODES_PAGE), cursor: String(cursor ?? 0), ...(parentId ? { parentId } : {}) }),
    pick: (b) => ({
      items: pickNodes(b),
      nextCursor: Number.isInteger(b?.nextCursor) ? b.nextCursor : null,
      head: { node: b?.parentNode ? toRecruiterNetworkNodeView(b.parentNode) : null, path: arr(b?.path).map(toRecruiterNetworkPathView) },
    }),
  },
  unplaced: {
    url: (_arg, cursor) => nodesUrl({ view: "unplaced", limit: String(NODES_PAGE), cursor: String(cursor ?? 0) }),
    pick: (b) => ({ items: pickNodes(b), nextCursor: Number.isInteger(b?.nextCursor) ? b.nextCursor : null, head: null }),
  },
  search: {
    url: (q, cursor) => {
      const p = new URLSearchParams({ limit: String(SEARCH_PAGE) });
      if (q) p.set("q", q);
      if (cursor) p.set("cursor", cursor);
      return `/api/recruiter/affiliates?${p.toString()}`;
    },
    pick: (b) => ({
      items: arr(b?.affiliates).map((x) => toRecruiterAffiliateListItemView(x, new Set())).filter((x) => typeof x.id === "string"),
      nextCursor: typeof b?.nextCursor === "string" ? b.nextCursor : null,
      head: null,
    }),
  },
};

const EMPTY = { key: null, items: [], total: 0, nextCursor: null, head: null, loading: true, error: null, moreError: null };

/**
 * One paged list of `kind` for `arg`: first page (replaces) or next page (appends, de-duplicated). A response of an
 * older request / another key is discarded; one "load more" at a time; a failed "load more" keeps the rows.
 */
function usePagedList(kind, arg, enabled, fail) {
  const key = `${kind}:${arg}`;
  const [list, setList] = useState(EMPTY);
  const gate = useRef(createRequestGate()).current;
  const moreInFlight = useRef(false);

  const load = useCallback(async (cursor = null) => {
    const more = cursor !== null;
    if (more && moreInFlight.current) return;
    const token = gate.begin();
    moreInFlight.current = more;
    setList((l) => (more ? { ...l, loading: true, moreError: null } : { ...EMPTY, key }));
    const r = await getJson(SOURCES[kind].url(arg, cursor));
    if (!gate.isCurrent(token)) return; // the mode / affiliate / search changed meanwhile: stale answer
    moreInFlight.current = false;
    if (fail(r)) return;
    if (!r.ok) {
      setList((l) => (more ? { ...l, loading: false, moreError: r.code } : { ...EMPTY, key, loading: false, error: r.code }));
      return;
    }
    const { items, nextCursor, head } = SOURCES[kind].pick(r.body);
    setList((l) => ({
      key,
      items: more ? mergeById(l.items, items) : mergeById([], items),
      total: Number.isInteger(r.body?.total) ? r.body.total : 0,
      nextCursor,
      head: more ? l.head : head, // details: X's own card (parentNode) only comes with the first page — kept
      loading: false, error: null, moreError: null,
    }));
  }, [key, kind, arg, fail, gate]);

  useEffect(() => {
    if (enabled) { load(null); return; }
    gate.invalidate();
    moreInFlight.current = false;
  }, [enabled, load, gate]);

  return { list: list.key === key ? list : { ...EMPTY, key }, load };
}

function StatusBadges({ a }) {
  const { t } = useRecruiterLocale();
  return (
    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
      <Badge tone={a.status === "ACTIVE" ? "green" : a.status === "INACTIVE" ? "red" : "slate"} data-affiliate-status={a.status ?? ""}>
        {STATUS_KEY[a.status] ? t(STATUS_KEY[a.status]) : t("status_unknown")}
      </Badge>
      <Badge tone={identityTone(a.identityStatus)} data-affiliate-identity={a.identityStatus}>
        {t("aff_identity_badge", { status: IDENTITY_KEY[a.identityStatus] ? t(IDENTITY_KEY[a.identityStatus]) : "—" })}
      </Badge>
    </div>
  );
}

/** "x / T" real delivered sales of one affiliate — nothing when the count is withheld (canViewOrders off). */
function DeliveredLine({ progress }) {
  const { t, lang } = useRecruiterLocale();
  const p = progressDisplay(progress, lang);
  if (!p) return null;
  return (
    <p className="text-xs text-gray-500" data-progress={p.threshold ? `${p.delivered}/${p.threshold}` : `${p.delivered}`}>
      {t("aff_delivered_sales")}: <b className={p.reached ? "text-green-700" : "text-gray-800"}><bdi dir="ltr">{p.ratio}</bdi></b>
    </p>
  );
}

/** The four figures of a network card: direct, whole downline, orders, delivered ("—" when orders are withheld). */
function miniFigures(a, t, locale) {
  const num = (v) => (Number.isInteger(v) ? fmt(v, locale) : "—");
  const real = a.orders?.real ?? null;
  return [
    ["direct", t("aff_fig_direct"), num(a.childrenCount)],
    ["network", t("aff_fig_network"), num(a.descendantsCount)],
    ["orders", t("aff_fig_orders"), real ? num(real.total) : "—"],
    ["delivered", t("aff_fig_delivered"), real ? num(real.delivered) : "—"],
  ];
}

/**
 * THE affiliate card (list, search results, details children, unplaced members): name, @username, level, activation
 * + identity badges, then either the 4 mini figures (network nodes) or the delivered progress (search items, which
 * carry no counts). With `href` the whole card is a link (≥ 44 px) with a chevron at the end.
 */
function AffiliateCard({ a, href, figures }) {
  const { t, lang, dir, intlLocale } = useRecruiterLocale();
  const body = (
    <>
      <div className="@container min-w-0 flex-1 space-y-2.5">
        <div className="flex items-start gap-2 min-w-0">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-gray-900 truncate" data-affiliate-name>{a.name || "—"}</p>
            <p className="text-xs text-gray-500 truncate" data-affiliate-username>
              {a.username ? <bdi dir="ltr">@{a.username}</bdi> : "—"}
            </p>
          </div>
          <Badge tone="violet" data-level-badge>{levelLabel(a.level, lang)}</Badge>
        </div>
        <StatusBadges a={a} />
        {figures ? (
          <dl className="grid grid-cols-2 @sm:grid-cols-4 gap-1.5 min-w-0">
            {miniFigures(a, t, intlLocale).map(([k, label, value]) => (
              <div key={k} className="flex flex-col-reverse rounded-lg bg-gray-50 px-2.5 py-1.5 min-w-0" data-mini={k}>
                <dt className="text-[11px] text-gray-500 leading-tight">{label}</dt>
                <dd className={`text-sm font-bold leading-tight ${k === "delivered" && value !== "—" ? "text-green-700" : "text-gray-900"}`}>{value}</dd>
              </div>
            ))}
          </dl>
        ) : <DeliveredLine progress={a.progress} />}
      </div>
      {href && <EndChevron dir={dir} className="w-5 h-5 shrink-0 self-center text-gray-300 group-hover:text-gray-500" aria-hidden="true" />}
    </>
  );
  const cls = "flex items-stretch gap-2 min-h-11 w-full rounded-2xl border border-gray-100 bg-white p-3.5 min-w-0";
  return href ? (
    <Link href={href} data-affiliate-card={a.id} aria-label={t("aff_card_details", { name: nameOf(a) })}
      className={`group ${cls} transition-colors hover:border-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300`}>
      {body}
    </Link>
  ) : <div data-affiliate-card={a.id} className={cls}>{body}</div>;
}

/** Cards of one paged list + its empty state, errors (first page / "load more") and "عرض المزيد". */
function PagedCards({ list, load, empty, figures = true, linkable = () => true }) {
  const { t } = useRecruiterLocale();
  return (
    <div className="space-y-3 min-w-0">
      {list.error ? (
        <RetryError code={list.error} onRetry={() => load(null)} />
      ) : list.items.length > 0 ? (
        <ul className="grid gap-2.5 lg:grid-cols-2 min-w-0">
          {list.items.map((a) => (
            <li key={a.id} className="min-w-0">
              <AffiliateCard a={a} figures={figures} href={linkable(a) ? detailsHref(a.id) : null} />
            </li>
          ))}
        </ul>
      ) : list.loading ? <LoadingBlock /> : <div data-empty>{empty}</div>}
      {list.moreError && <RetryError code={list.moreError} onRetry={() => load(list.nextCursor)} />}
      {!list.error && !list.moreError && list.nextCursor !== null && list.items.length > 0 && (
        <div className="flex justify-center">
          <button type="button" onClick={() => load(list.nextCursor)} disabled={list.loading} aria-busy={list.loading || undefined} data-load-more
            className={`${ui.btnSecondary} w-full sm:w-auto`}>{list.loading ? t("common_loading") : t("common_load_more")}</button>
        </div>
      )}
    </div>
  );
}

/** A small gray section title with the total (data-total) at the end. */
function ListTitle({ title, list, totalLabel }) {
  const { t, intlLocale } = useRecruiterLocale();
  return (
    <div className="flex items-center justify-between gap-3 min-w-0">
      <h2 className="text-sm font-bold text-gray-700 min-w-0 truncate">{title}</h2>
      {!list.error && !(list.loading && list.items.length === 0) && (
        <p className="shrink-0 text-xs text-gray-500" data-total>{totalLabel ?? t("common_total")}: <b className="text-gray-900">{fmt(list.total, intlLocale)}</b></p>
      )}
    </div>
  );
}

/** Breadcrumb from the API `path` (ancestors … X); a long path shows the first, "…" and the last two. */
function Crumbs({ path }) {
  const { t, dir } = useRecruiterLocale();
  const current = path[path.length - 1];
  const shown = path.length > 4 ? [path[0], null, ...path.slice(-2)] : path;
  return (
    <nav aria-label={t("net_path")} data-breadcrumb className="min-w-0 max-w-full text-sm">
      <ol className="flex flex-wrap items-center gap-x-1 min-w-0">
        <li><Link href={BASE} className="block py-3 px-1 font-semibold text-violet-600 hover:underline" data-breadcrumb-home>{t("nav_affiliates")}</Link></li>
        {shown.map((p, i) => (
          <li key={p?.id ?? `gap-${i}`} className="flex items-center gap-1 min-w-0">
            <EndChevron dir={dir} className="w-3.5 h-3.5 shrink-0 text-gray-300" aria-hidden="true" />
            {!p ? <span className="text-gray-400" aria-hidden="true">…</span>
              : p === current ? <span className="block max-w-[10rem] truncate font-bold text-gray-900" aria-current="page">{nameOf(p)}</span>
                : <Link href={detailsHref(p.id)} className="block max-w-[9rem] truncate py-3 px-1 font-semibold text-violet-600 hover:underline" data-breadcrumb-item>{nameOf(p)}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** X's own card: identity line + 5 compact figures (direct, downline, orders, delivered, status). */
function DetailsCard({ node }) {
  const { t, lang, intlLocale } = useRecruiterLocale();
  const p = progressDisplay(node.progress, lang);
  const badges = nodeBadges(node, lang);
  return (
    <Card className={`${ui.cardPad} space-y-4`} data-details-card={node.id}>
      <div className="flex items-start gap-3 min-w-0">
        <span className="grid place-items-center w-11 h-11 shrink-0 rounded-xl bg-violet-50 text-violet-600 font-bold" aria-hidden="true">
          {nameOf(node).slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-gray-900 truncate" data-affiliate-name>{node.name || "—"}</p>
          <p className="text-xs text-gray-500 truncate" data-affiliate-username>{node.username ? <bdi dir="ltr">@{node.username}</bdi> : "—"}</p>
        </div>
        <Badge tone="violet" data-level-badge>{levelLabel(node.level, lang)}</Badge>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 min-w-0">
        {miniFigures(node, t, intlLocale).map(([k, label, value]) => (
          <div key={k} className="rounded-xl bg-gray-50 px-3.5 py-3 min-w-0" data-details-figure={k}>
            <dt className="text-xs text-gray-500 leading-tight">{label}</dt>
            <dd className={`mt-1 text-lg font-bold leading-none ${k === "delivered" && value !== "—" ? "text-green-700" : "text-gray-900"}`}>{value}</dd>
          </div>
        ))}
        <div className="col-span-2 sm:col-span-4 rounded-xl bg-gray-50 px-3.5 py-3 min-w-0" data-details-figure="status">
          <dt className="text-xs text-gray-500 leading-tight">{t("common_status")}</dt>
          <dd className="mt-2"><StatusBadges a={node} /></dd>
        </div>
      </dl>
      {!node.orders && <p className={ui.hint} data-orders-hidden>{t("net_orders_hidden")}</p>}
      {(p || badges.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          {p && <DeliveredLine progress={node.progress} />}
          {badges.map((b) => <Badge key={b.key} tone={b.tone} data-badge={b.key}>{b.label}</Badge>)}
        </div>
      )}
    </Card>
  );
}

/** Details mode (?id=X): back, breadcrumb, X's card, then "شبكة <name>" = X's children (each opens its own details). */
function Details({ list, load }) {
  const { t, lang } = useRecruiterLocale();
  const node = list.head?.node ?? null;
  const path = list.head?.path ?? [];
  const parent = path.length >= 2 ? path[path.length - 2] : null;
  const back = parent ? { href: detailsHref(parent.id), label: t("aff_back_to", { name: nameOf(parent) }) } : { href: BASE, label: t("aff_back_list") };
  const name = node ? nameOf(node) : path.length ? nameOf(path[path.length - 1]) : "";

  if (list.error === "NOT_FOUND") {
    return (
      <div className="space-y-5 min-w-0" data-details data-not-found>
        <PageHeader Icon={Users} title={t("aff_not_in_network")} back={{ href: BASE, label: t("aff_back_list") }} />
        <EmptyState Icon={Users} text={recruiterErrorLabel("NOT_FOUND", lang)}>
          <Link href={BASE} className={`${ui.btnSecondary} mt-1`} data-back-list>{t("aff_back_list")}</Link>
        </EmptyState>
      </div>
    );
  }
  const headLoading = list.loading && !list.head;
  return (
    <div className="space-y-5 min-w-0" data-details>
      <PageHeader Icon={Users} title={name || t("aff_details_title")} back={back} />
      {path.length > 0 && <Crumbs path={path} />}
      {list.error ? <RetryError code={list.error} onRetry={() => load(null)} />
        : headLoading ? <LoadingBlock />
          : (
            <>
              {node && <DetailsCard node={node} />}
              <section className="space-y-3 min-w-0" aria-label={t("aff_network_of", { name })} data-children>
                <ListTitle title={<><Network className="inline w-4 h-4 me-1.5 text-gray-400 align-[-2px]" aria-hidden="true" />{t("aff_network_of", { name })}</>} list={list} />
                <PagedCards list={list} load={load} empty={<EmptyState Icon={Network} text={t("aff_no_children")} />} />
              </section>
            </>
          )}
    </div>
  );
}

function AffiliatesView() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id") || "";
  const urlQ = (params.get("q") || "").trim().slice(0, QUERY_MAX);
  const mode = id ? "details" : urlQ ? "search" : "list";
  const { t, lang } = useRecruiterLocale();
  const [notice, setNotice] = useState(""); // error CODE (RECRUITER_DISABLED), rendered in the market language
  const [query, setQuery] = useState(urlQ);
  const [showUnplaced, setShowUnplaced] = useState(false);
  const fail = useCallback((r) => handleAuth(r, router, setNotice), [router]);
  const { permsError, retryPerms, canCreate } = useRecruiterPerms(router, setNotice);
  const { list, load } = usePagedList(mode === "search" ? "search" : "nodes", mode === "details" ? id : urlQ, true, fail);
  const unplaced = usePagedList("unplaced", "", showUnplaced && mode === "list", fail);

  // Debounced search → the URL (?q=, replaced: no history entry per keystroke); the empty query applies at once.
  const timer = useRef(null);
  const pushedQ = useRef(urlQ);
  const onSearch = (value) => {
    setQuery(value);
    clearTimeout(timer.current);
    const next = value.trim().slice(0, QUERY_MAX);
    timer.current = setTimeout(() => {
      if (next === pushedQ.current) return;
      pushedQ.current = next;
      router.replace(next ? `${BASE}?q=${encodeURIComponent(next)}` : BASE, { scroll: false });
    }, next ? DEBOUNCE_MS : 0);
  };
  // The URL changed by navigation (back, breadcrumb, a link): the search box follows it.
  useEffect(() => {
    if (urlQ === pushedQ.current) return;
    pushedQ.current = urlQ;
    clearTimeout(timer.current);
    setQuery(urlQ);
  }, [urlQ]);
  useEffect(() => {
    const t = timer;
    return () => clearTimeout(t.current);
  }, []);

  if (notice) return <CenteredNotice>{recruiterErrorLabel(notice, lang)}</CenteredNotice>;

  return (
    <div className="space-y-5 min-w-0" data-recruiter-affiliates data-mode={mode}>
      {mode === "details" ? <Details list={list} load={load} /> : (
        <>
          <PageHeader Icon={Users} title={t("nav_affiliates")} subtitle={t("aff_subtitle")} back={null} actions={canCreate && (
            <Link href="/recruiter/affiliates/new" data-create-link className={ui.btnPrimary}>
              <UserPlus className="w-4 h-4" aria-hidden="true" />
              {t("aff_create")}
            </Link>
          )}>
            <div className="relative min-w-0">
              <Search className="w-4 h-4 text-gray-400 absolute top-1/2 -translate-y-1/2 start-3.5 pointer-events-none" aria-hidden="true" />
              <label htmlFor="aff-search" className="sr-only">{t("aff_search_label")}</label>
              <input id="aff-search" type="search" value={query} maxLength={QUERY_MAX} onChange={(e) => onSearch(e.target.value)}
                placeholder={t("aff_search_placeholder")} autoComplete="off" data-search className={`${ui.input} ps-10`} />
            </div>
          </PageHeader>

          {permsError && <RetryError code={permsError} onRetry={retryPerms} />}

          <section className="space-y-3 min-w-0" aria-label={mode === "search" ? t("aff_search_results") : t("aff_top_level")} data-affiliates-list>
            <ListTitle title={mode === "search" ? t("aff_search_results") : t("aff_top_level")} totalLabel={mode === "search" ? t("aff_results") : t("common_total")} list={list} />
            {mode === "search" ? (
              <PagedCards list={list} load={load} figures={false} linkable={(a) => a.level !== null}
                empty={<EmptyState Icon={Search} text={t("aff_no_results")} />} />
            ) : (
              <PagedCards list={list} load={load} empty={(
                <EmptyState Icon={Users} text={t("aff_empty_network")}>
                  {canCreate && (
                    <Link href="/recruiter/affiliates/new" className={`${ui.btnPrimary} mt-1`} data-empty-create>
                      <UserPlus className="w-4 h-4" aria-hidden="true" />
                      {t("aff_create")}
                    </Link>
                  )}
                </EmptyState>
              )} />
            )}
          </section>

          {mode === "list" && (showUnplaced ? (
            <section className="space-y-3 min-w-0" aria-label={t("aff_unplaced_aria")} data-unplaced data-unplaced-list>
              <div className="flex items-center justify-between gap-3 min-w-0">
                <h2 className="flex items-center gap-1.5 text-sm font-bold text-gray-700 min-w-0">
                  <TriangleAlert className="w-4 h-4 shrink-0 text-amber-500" aria-hidden="true" />
                  <span className="min-w-0">{t("aff_unplaced_title")}</span>
                </h2>
                <button type="button" onClick={() => setShowUnplaced(false)} className={`shrink-0 text-xs ${ui.link} min-h-11 px-1`} data-unplaced-hide>{t("common_hide")}</button>
              </div>
              <PagedCards list={unplaced.list} load={unplaced.load} figures={false} linkable={() => false}
                empty={<EmptyState Icon={Users} text={t("aff_unplaced_empty")} />} />
            </section>
          ) : (
            <button type="button" onClick={() => setShowUnplaced(true)} data-unplaced-show
              className="inline-flex items-center gap-1.5 min-h-11 text-xs font-semibold text-gray-500 hover:text-gray-800">
              <TriangleAlert className="w-4 h-4 text-amber-500" aria-hidden="true" />
              {t("aff_unplaced_show")}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

export default function RecruiterAffiliatesPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <AffiliatesView />
    </Suspense>
  );
}
