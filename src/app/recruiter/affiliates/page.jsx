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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ListChecks, Search, UserPlus } from "lucide-react";
import { toRecruiterAffiliateListItemView } from "@/lib/recruiterVisibility";
import {
  Chip, ErrorBox, IDENTITY_LABEL, Loading, NodeBadges, PageNotice, ProgressBar, STATUS_LABEL, fmt, getJson, handleAuth, identityTone,
  useRecruiterPerms,
} from "../network/networkUi";
import { NETWORK_INVITED_LABEL, createRequestGate, levelLabel, mergeById } from "../recruiterUiState";

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
  if (!parent) return <span className="text-[11px] text-slate-500" data-parent="none">بدون أب داخل شبكتك (حساب رئيسي)</span>;
  return (
    <span className="text-[11px] text-slate-600 min-w-0 truncate" data-parent={parent.id}>
      الأب: <b>{parent.name || parent.username || "—"}</b>
      {parent.username && <>{" "}<bdi className="text-slate-400" dir="ltr">@{parent.username}</bdi></>}
      {!parent.linkedToMe && <span className="text-slate-500" data-parent-invited> · {NETWORK_INVITED_LABEL}</span>}
    </span>
  );
}

function AffiliateCard({ a }) {
  return (
    <li className="bg-white rounded-xl border border-slate-200 p-3 space-y-2 min-w-0" data-affiliate-id={a.id} data-affiliate-level={a.level ?? ""}>
      <div className="flex items-start gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <p className="font-bold text-sm truncate" data-affiliate-name>{a.name || "—"}</p>
          <p className="text-xs text-slate-500 truncate" dir="ltr" data-affiliate-username>{a.username || "—"}</p>
        </div>
        <Chip tone="slate" data-level-badge>{levelLabel(a.level)}</Chip>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
        <Chip tone={a.status === "ACTIVE" ? "green" : a.status === "INACTIVE" ? "red" : "slate"} data-affiliate-status={a.status ?? ""}>
          {STATUS_LABEL[a.status] ?? "غير محدد"}
        </Chip>
        <Chip tone={identityTone(a.identityStatus)} data-affiliate-identity={a.identityStatus}>
          البطاقة الوطنية: {IDENTITY_LABEL[a.identityStatus]}
        </Chip>
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

  if (notice) return <PageNotice text={notice} />;

  const searching = list.q !== "";
  return (
    <div className="min-h-screen [contain:inline-size]" data-recruiter-affiliates>
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-4xl mx-auto flex items-center gap-3 px-4 py-3 min-w-0">
          <Link href="/recruiter" className="shrink-0 p-2 -m-2 rounded-lg text-slate-700 hover:bg-slate-100" aria-label="الرجوع للوحة" data-back>
            <ArrowRight className="w-5 h-5" aria-hidden="true" />
          </Link>
          <ListChecks className="w-5 h-5 text-emerald-600 shrink-0" aria-hidden="true" />
          <h1 className="text-base sm:text-lg font-bold truncate min-w-0 flex-1">قائمة الأفلييت ديالي</h1>
          {canCreate && (
            <Link href="/recruiter/affiliates/new" data-create-link
              className="shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 text-white text-sm font-bold px-3 py-1.5 hover:bg-emerald-700">
              <UserPlus className="w-4 h-4" aria-hidden="true" />
              <span className="hidden sm:inline">إنشاء أفلييت</span>
              <span className="sm:hidden">إنشاء</span>
            </Link>
          )}
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4 sm:p-6 space-y-4 min-w-0">
        <p className="text-sm text-slate-600">
          كل الأفلييت في شبكتك (الذين أنشأتهم والمدعوون عبرهم — تُحتسب عنهم جميعاً المكافآت)، مع تقدّم كل واحد. المستويات مطلقة، نفسها في الشجرة والإحصائيات.
        </p>
        {permsError && <ErrorBox code={permsError} onRetry={retryPerms} />}

        <div className="relative min-w-0">
          <Search className="w-4 h-4 text-slate-400 absolute top-1/2 -translate-y-1/2 start-3 pointer-events-none" aria-hidden="true" />
          <label htmlFor="aff-search" className="sr-only">بحث</label>
          <input id="aff-search" type="search" value={query} maxLength={QUERY_MAX} onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث بالاسم أو اسم المستخدم" autoComplete="off" data-search
            className="w-full min-w-0 rounded-xl border border-slate-300 bg-white ps-9 pe-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
        </div>

        <section className="space-y-3 min-w-0" aria-label="قائمة الأفلييت" data-affiliates-list>
          {!list.error && !(list.loading && list.items.length === 0) && (
            <p className="text-sm text-slate-600" data-total>
              {searching ? "النتائج" : "المجموع"}: <b>{fmt(list.total)}</b>
              {list.items.length > 0 && list.items.length < list.total && <span className="text-slate-500"> (معروض {fmt(list.items.length)})</span>}
            </p>
          )}
          {list.error ? (
            <ErrorBox code={list.error} onRetry={() => load(list.q)} />
          ) : list.items.length > 0 ? (
            <ul className="space-y-2 min-w-0">
              {list.items.map((a) => <AffiliateCard key={a.id} a={a} />)}
            </ul>
          ) : !list.loading && (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-6 text-center space-y-3" data-empty>
              <p className="text-sm text-slate-600">{searching ? "لا توجد نتائج لهذا البحث." : "لا يوجد أفلييت في شبكتك بعد"}</p>
              {!searching && canCreate && (
                <Link href="/recruiter/affiliates/new" className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 text-white font-bold px-4 py-2 hover:bg-emerald-700" data-empty-create>
                  <UserPlus className="w-4 h-4" aria-hidden="true" />
                  إنشاء أفلييت
                </Link>
              )}
            </div>
          )}
          {list.loading && <Loading />}
          {list.moreError && <ErrorBox code={list.moreError} onRetry={() => load(list.q, list.nextCursor)} />}
          {!list.loading && !list.error && !list.moreError && list.nextCursor && (
            <button type="button" onClick={() => load(list.q, list.nextCursor)} data-load-more
              className="w-full sm:w-auto rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50">عرض المزيد</button>
          )}
        </section>
      </main>
    </div>
  );
}

