"use client";
/**
 * /recruiter/affiliates — the recruiter's affiliates list (Affiliate Recruiter System, Phase 7
 * Stage C). Arabic, RTL, READ ONLY.
 *
 *   • GET /api/recruiter/affiliates?q=&cursor=&limit=  → the recruiter's network N(R) (Phase 7 Stage E:
 *     its own affiliates and those invited below them), newest first, keyset paged (nextCursor),
 *     `total` matching q; per item: status, identity status, absolute level, parent in the network
 *     (or null), "مدعو عبر الشبكة" when not created directly (information), progress and the latest
 *     reward cycle
 *   • GET /api/recruiter/me                            → canCreateAffiliates (creation buttons)
 * Search is debounced; a stale answer (the search changed meanwhile) is discarded; "عرض المزيد"
 * appends the next page without duplicates and its failure keeps the rows already shown.
 * Progress counts appear only when the server sends them (canViewOrders) — never as zeros.
 * Built only from recruiterVisibility.js projections.
 * Phase 2 (UI only): rendered inside the recruiter app shell with the shared ui.jsx primitives.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ListChecks, Search, UserPlus, Users } from "lucide-react";
import { toRecruiterAffiliateListItemView } from "@/lib/recruiterVisibility";
import {
  IDENTITY_LABEL, Loading, NodeBadges, ProgressBar, STATUS_LABEL, fmt, getJson, handleAuth, identityTone,
  useRecruiterPerms,
} from "../network/networkUi";
import { NETWORK_INVITED_LABEL, createRequestGate, levelLabel, mergeById } from "../recruiterUiState";
import { Badge, Card, CenteredNotice, EmptyState, LoadingBlock, PageHeader, RetryError, ui } from "../_components/ui";

const PAGE = 25;
const QUERY_MAX = 40;
const DEBOUNCE_MS = 300;
const listUrl = (q, cursor) => {
  const p = new URLSearchParams({ limit: String(PAGE) });
  if (q) p.set("q", q);
  if (cursor) p.set("cursor", cursor);
  return `/api/recruiter/affiliates?${p.toString()}`;
};

function ParentLine({ parent }) {
  if (!parent) return <span className="text-xs text-slate-500" data-parent="none">بدون أب داخل شبكتك (حساب رئيسي)</span>;
  return (
    <span className="text-xs text-slate-600 min-w-0 truncate" data-parent={parent.id}>
      الأب: <b>{parent.name || parent.username || "—"}</b>
      {parent.username && <>{" "}<bdi className="text-slate-400" dir="ltr">@{parent.username}</bdi></>}
      {!parent.linkedToMe && <span className="text-slate-500" data-parent-invited> · {NETWORK_INVITED_LABEL}</span>}
    </span>
  );
}

function AffiliateCard({ a }) {
  return (
    <li className={`${ui.panel} p-4 space-y-3 min-w-0`} data-affiliate-id={a.id} data-affiliate-level={a.level ?? ""}>
      <div className="flex items-start gap-3 min-w-0">
        <span className="grid place-items-center w-10 h-10 shrink-0 rounded-2xl bg-white border border-violet-100 text-violet-600" aria-hidden="true">
          <Users className="w-5 h-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-sm text-slate-900 truncate" data-affiliate-name>{a.name || "—"}</p>
          <p className="text-xs text-slate-500 truncate" dir="ltr" data-affiliate-username>{a.username || "—"}</p>
        </div>
        <Badge tone="violet" data-level-badge>{levelLabel(a.level)}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
        <Badge tone={a.status === "ACTIVE" ? "green" : a.status === "INACTIVE" ? "red" : "slate"} data-affiliate-status={a.status ?? ""}>
          {STATUS_LABEL[a.status] ?? "غير محدد"}
        </Badge>
        <Badge tone={identityTone(a.identityStatus)} data-affiliate-identity={a.identityStatus}>
          البطاقة الوطنية: {IDENTITY_LABEL[a.identityStatus]}
        </Badge>
      </div>
      <div className="flex min-w-0"><ParentLine parent={a.parent} /></div>
      <NodeBadges node={a} />
      <ProgressBar progress={a.progress} />
    </li>
  );
}

export default function RecruiterAffiliatesPage() {
  const router = useRouter();
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [list, setList] = useState({ items: [], total: 0, nextCursor: null, loading: true, error: null, moreError: null, q: "" });
  const gate = useRef(createRequestGate()).current;
  const moreInFlight = useRef(false);
  const { permsError, retryPerms, canCreate } = useRecruiterPerms(router, setNotice);

  /** First page of `q` (replaces the list) or the next page (appends, de-duplicated). */
  const load = useCallback(async (q, cursor = null) => {
    if (cursor && moreInFlight.current) return;
    const token = gate.begin();
    moreInFlight.current = !!cursor;
    setList((l) => (cursor ? { ...l, loading: true, moreError: null } : { ...l, loading: true, error: null, moreError: null }));
    const r = await getJson(listUrl(q, cursor));
    if (!gate.isCurrent(token)) return; // the search changed meanwhile: stale answer
    moreInFlight.current = false;
    if (handleAuth(r, router, setNotice)) return;
    if (!r.ok) {
      setList((l) => (cursor ? { ...l, loading: false, moreError: r.code } : { ...l, items: [], loading: false, error: r.code, q }));
      return;
    }
    const items = (Array.isArray(r.body?.affiliates) ? r.body.affiliates : []).map((x) => toRecruiterAffiliateListItemView(x, new Set()))
      .filter((x) => typeof x.id === "string");
    setList((l) => ({
      items: cursor ? mergeById(l.items, items) : mergeById([], items),
      total: Number.isInteger(r.body?.total) ? r.body.total : 0,
      nextCursor: typeof r.body?.nextCursor === "string" ? r.body.nextCursor : null,
      loading: false, error: null, moreError: null, q,
    }));
  }, [gate, router]);

  // Debounced search (first page); the empty query loads at once.
  useEffect(() => {
    const q = query.trim().slice(0, QUERY_MAX);
    const t = setTimeout(() => { load(q); }, q ? DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [query, load]);

  if (notice) return <CenteredNotice>{notice}</CenteredNotice>;

  const searching = list.q !== "";
  return (
    <div className="space-y-5 sm:space-y-6 min-w-0" data-recruiter-affiliates>
      <PageHeader Icon={ListChecks} title="قائمة الأفلييت ديالي"
        subtitle="كل الأفلييت في شبكتك (الذين أنشأتهم والمدعوون عبرهم — تُحتسب عنهم جميعاً المكافآت)، مع تقدّم كل واحد. المستويات مطلقة، نفسها في الشجرة والإحصائيات.">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 min-w-0">
          <div className="relative min-w-0 flex-1">
            <Search className="w-4 h-4 text-violet-400 absolute top-1/2 -translate-y-1/2 start-3.5 pointer-events-none" aria-hidden="true" />
            <label htmlFor="aff-search" className="sr-only">بحث</label>
            <input id="aff-search" type="search" value={query} maxLength={QUERY_MAX} onChange={(e) => setQuery(e.target.value)}
              placeholder="ابحث بالاسم أو اسم المستخدم" autoComplete="off" data-search
              className={`${ui.input} ps-10`} />
          </div>
          {canCreate && (
            <Link href="/recruiter/affiliates/new" data-create-link className={`${ui.btnPrimary} shrink-0`}>
              <UserPlus className="w-4 h-4" aria-hidden="true" />
              <span className="hidden sm:inline">إنشاء أفلييت</span>
              <span className="sm:hidden">إنشاء</span>
            </Link>
          )}
        </div>
      </PageHeader>

      {permsError && <RetryError code={permsError} onRetry={retryPerms} />}

      <Card className={`${ui.cardPad} space-y-4`} aria-label="قائمة الأفلييت" data-affiliates-list>
        {!list.error && !(list.loading && list.items.length === 0) && (
          <p className="text-sm text-slate-600" data-total>
            {searching ? "النتائج" : "المجموع"}: <b className="text-slate-900">{fmt(list.total)}</b>
            {list.items.length > 0 && list.items.length < list.total && <span className="text-slate-500"> (معروض {fmt(list.items.length)})</span>}
          </p>
        )}
        {list.error ? (
          <RetryError code={list.error} onRetry={() => load(list.q)} />
        ) : list.items.length > 0 ? (
          <ul className="grid gap-3 lg:grid-cols-2 min-w-0">
            {list.items.map((a) => <AffiliateCard key={a.id} a={a} />)}
          </ul>
        ) : !list.loading && (
          <div data-empty>
            <EmptyState Icon={Users} text={searching ? "لا توجد نتائج لهذا البحث." : "لا يوجد أفلييت في شبكتك بعد"}>
              {!searching && canCreate && (
                <Link href="/recruiter/affiliates/new" className={`${ui.btnPrimary} mt-1`} data-empty-create>
                  <UserPlus className="w-4 h-4" aria-hidden="true" />
                  إنشاء أفلييت
                </Link>
              )}
            </EmptyState>
          </div>
        )}
        {list.loading && (list.items.length === 0 ? <LoadingBlock /> : <Loading />)}
        {list.moreError && <RetryError code={list.moreError} onRetry={() => load(list.q, list.nextCursor)} />}
        {!list.loading && !list.error && !list.moreError && list.nextCursor && (
          <div className="flex justify-center">
            <button type="button" onClick={() => load(list.q, list.nextCursor)} data-load-more
              className={`${ui.btnSecondary} w-full sm:w-auto`}>عرض المزيد</button>
          </div>
        )}
      </Card>
    </div>
  );
}
