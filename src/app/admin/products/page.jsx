"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import {
  Trash2, Edit3, Package, Plus, Search, Copy, Loader2,
  ChevronDown, X, Tags, BarChart2, CheckSquare, TrendingUp,
  ChevronLeft, ChevronRight, Lock, LockOpen,
} from "lucide-react";
import DeleteConfirmationModal from "@/components/block/DeleteConfirmationModal";
import formatDate from "@/utils/formatDate";
import CustomButton from "@/components/block/CustomButton";

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function parseCollections(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c.filter(Boolean);
  try { const p = JSON.parse(c); return Array.isArray(p) ? p.filter(Boolean) : []; }
  catch { return []; }
}

const VIDEO_EXTS = /\.(mp4|webm|ogg|mov|avi|mkv|m4v)(\?.*)?$/i;

function imgSrc(v) {
  if (!v) return "";
  const url = typeof v === "string" ? v : v.url || v.src || "";
  // Return empty string for video files so the caller renders the placeholder icon
  return VIDEO_EXTS.test(url) ? "" : url;
}

/** Pick the first image (non-video) from a product's images array */
function firstImageSrc(images) {
  if (!Array.isArray(images)) return "";
  for (const item of images) {
    const url = imgSrc(item);
    if (url) return url;
  }
  return "";
}

function fmt(price) {
  if (price == null || price === "") return "—";
  return `${Number(price).toFixed(0)} MAD`;
}

function ctr(orders, clicks) {
  if (!clicks) return "—";
  return `${((orders / clicks) * 100).toFixed(1)}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRODUCT LOCK — manual per product. Locked: still listed on the storefront
//  (image, name, price + lock) but nobody can open or buy it (server-enforced)
// ─────────────────────────────────────────────────────────────────────────────

function ProductLockToggle({ locked, busy, onToggle, compact = false }) {
  return (
    <button type="button" onClick={onToggle} disabled={busy}
      title={locked ? "مقفل: ظاهر في المتجر لكن لا يمكن فتحه أو شراؤه — اضغط لفتحه" : "مفتوح: يعمل بشكل عادي — اضغط لقفله"}
      aria-pressed={locked}
      className={`inline-flex items-center gap-1 rounded-full border font-semibold transition-colors disabled:opacity-50
        ${compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]"}
        ${locked
          ? "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"
          : "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"}`}>
      {busy
        ? <Loader2 className="w-3 h-3 animate-spin" />
        : locked ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
      {locked ? "مقفل" : "مفتوح"}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATUS BADGE
// ─────────────────────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const active = (status || "").toLowerCase() === "active";
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold border
      ${active
        ? "bg-green-50 text-green-700 border-green-200"
        : "bg-gray-100 text-gray-500 border-gray-200"}`}>
      {active ? "نشط" : "غير نشط"}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  STAT PILL
// ─────────────────────────────────────────────────────────────────────────────

function StatPill({ value, label, color = "gray" }) {
  const colors = {
    gray:   "bg-gray-50   text-gray-600",
    blue:   "bg-blue-50   text-blue-700",
    green:  "bg-green-50  text-green-700",
    orange: "bg-orange-50 text-orange-700",
  };
  return (
    <span className={`inline-flex flex-col items-center px-2 py-0.5 rounded-lg text-[11px] font-semibold ${colors[color]}`}>
      <span className="font-black text-sm leading-none">{value}</span>
      <span className="font-normal text-[9px] leading-tight">{label}</span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  PAGINATION BAR
// ─────────────────────────────────────────────────────────────────────────────

function PaginationBar({ page, total, onChange }) {
  if (total <= 1) return null;
  const pages = Array.from({ length: Math.min(total, 7) }, (_, i) => {
    if (total <= 7) return i + 1;
    if (page <= 4) return i + 1;
    if (page >= total - 3) return total - 6 + i;
    return page - 3 + i;
  });
  return (
    <div className="flex items-center gap-1">
      <button onClick={() => onChange(Math.max(1, page - 1))} disabled={page === 1}
        className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30 disabled:pointer-events-none">
        <ChevronRight className="w-4 h-4" />
      </button>
      {pages.map((p) => (
        <button key={p} onClick={() => onChange(p)}
          className={`w-8 h-8 rounded-lg text-sm font-semibold transition-colors
            ${p === page ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"}`}>
          {p}
        </button>
      ))}
      <button onClick={() => onChange(Math.min(total, page + 1))} disabled={page === total}
        className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30 disabled:pointer-events-none">
        <ChevronLeft className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  BULK ACTIONS BAR
// ─────────────────────────────────────────────────────────────────────────────

function BulkActionsBar({ count, collections, onAddCollection, onRemoveCollection, onDelete, onClear, loading }) {
  const [action,     setAction]     = useState("");
  const [collection, setCollection] = useState("");

  const canApply = action && (action === "delete" || collection);

  const apply = () => {
    if (!action) return;
    if (action === "add")    onAddCollection(collection);
    if (action === "remove") onRemoveCollection(collection);
    if (action === "delete") onDelete();
  };

  return (
    <div className="flex items-center gap-3 flex-wrap bg-blue-50 border border-blue-200 rounded-2xl px-4 py-3">
      <div className="flex items-center gap-2 text-blue-700 font-semibold text-sm">
        <CheckSquare className="w-4 h-4" />
        {count} محدد
      </div>
      <div className="h-4 w-px bg-blue-200" />

      {/* Action selector */}
      <select value={action} onChange={(e) => { setAction(e.target.value); setCollection(""); }}
        className="text-sm border border-blue-200 rounded-xl px-3 py-1.5 bg-white focus:outline-none focus:border-blue-400 text-gray-700">
        <option value="">— اختر إجراء —</option>
        <option value="add">إضافة إلى مجموعة</option>
        <option value="remove">إزالة من مجموعة</option>
        <option value="delete">حذف المحدد</option>
      </select>

      {/* Collection picker (when relevant) */}
      {(action === "add" || action === "remove") && (
        <select value={collection} onChange={(e) => setCollection(e.target.value)}
          className="text-sm border border-blue-200 rounded-xl px-3 py-1.5 bg-white focus:outline-none focus:border-blue-400 text-gray-700">
          <option value="">— اختر مجموعة —</option>
          {collections.map((c) => (
            <option key={c._id || c.title} value={c.title}>{c.title}</option>
          ))}
        </select>
      )}

      {/* Apply */}
      <button onClick={apply} disabled={!canApply || loading}
        className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:pointer-events-none transition-colors">
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Tags className="w-3.5 h-3.5" />}
        تطبيق
      </button>

      <button onClick={onClear} className="mr-auto p-1 text-blue-400 hover:text-blue-600 transition-colors">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZES = [10, 20, 30, 50, 100];

export default function ProductTablePage() {
  // ── Core data ─────────────────────────────────────────────────────────────
  const [products,    setProducts]    = useState([]);
  const [collections, setCollections] = useState([]);
  const [analytics,   setAnalytics]   = useState({});
  const [loading,     setLoading]     = useState(true);

  // ── Search / pagination ───────────────────────────────────────────────────
  const [search,   setSearch]   = useState("");
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // ── Sort ──────────────────────────────────────────────────────────────────
  const [sortKey, setSortKey]   = useState("createdAt"); // createdAt | orders | clicks
  const [sortDir, setSortDir]   = useState("desc");

  // ── Bulk selection ────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  // ── Delete modal ──────────────────────────────────────────────────────────
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteTarget,    setDeleteTarget]    = useState(null); // single _id

  // ── Duplicate ─────────────────────────────────────────────────────────────
  const [duplicating, setDuplicating] = useState(null); // _id of product being duplicated

  // ── Product lock (separate admin endpoint; not part of product PUT) ────────
  const [lockedIds, setLockedIds] = useState(new Set());
  const [lockBusy,  setLockBusy]  = useState(null);     // _id being toggled

  // ─────────────────────────────────────────────────────────────────────────
  //  FETCH
  // ─────────────────────────────────────────────────────────────────────────

  const fetchProducts = useCallback(async () => {
    try {
      const r = await fetch("/api/products?status=all");
      const d = await r.json();
      // Already sorted by createdAt DESC from the API — keep that order
      setProducts(Array.isArray(d) ? d : []);
    } catch { setProducts([]); }
  }, []);

  const fetchCollections = useCallback(async () => {
    try {
      const r = await fetch("/api/collection");
      const d = await r.json();
      setCollections(Array.isArray(d) ? d : []);
    } catch { setCollections([]); }
  }, []);

  const fetchLocks = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/products/locks", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setLockedIds(new Set(Array.isArray(d.lockedIds) ? d.lockedIds : []));
      }
    } catch { /* non-critical: every product shows as unlocked until reload */ }
  }, []);

  const toggleProductLock = async (id) => {
    const next = !lockedIds.has(id);
    setLockBusy(id);
    try {
      const r = await fetch(`/api/admin/products/${encodeURIComponent(id)}/lock`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locked: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "تعذر تحديث حالة القفل");
      setLockedIds((prev) => {
        const s = new Set(prev);
        if (d.isLocked) s.add(id); else s.delete(id);
        return s;
      });
    } catch (e) {
      alert(e.message || "تعذر تحديث حالة القفل");
    } finally {
      setLockBusy(null);
    }
  };

  const fetchAnalytics = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/product-analytics");
      if (r.ok) setAnalytics(await r.json());
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => {
    Promise.all([fetchProducts(), fetchCollections(), fetchAnalytics(), fetchLocks()])
      .finally(() => setLoading(false));
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  //  FILTER + SORT + PAGINATE (client-side)
  // ─────────────────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = q
      ? products.filter((p) =>
          p.title?.toLowerCase().includes(q) ||
          parseCollections(p.collections).join(" ").toLowerCase().includes(q)
        )
      : [...products];

    // Secondary sort (API already returns by createdAt DESC — enhance)
    if (sortKey === "orders") {
      list.sort((a, b) => {
        const aO = analytics[a._id]?.orders ?? 0;
        const bO = analytics[b._id]?.orders ?? 0;
        return sortDir === "desc" ? bO - aO : aO - bO;
      });
    } else if (sortKey === "clicks") {
      list.sort((a, b) => {
        const aC = analytics[a._id]?.clicks ?? 0;
        const bC = analytics[b._id]?.clicks ?? 0;
        return sortDir === "desc" ? bC - aC : aC - bC;
      });
    }
    // "createdAt" → keep API's default DESC order

    return list;
  }, [products, search, sortKey, sortDir, analytics]);

  const totalPages = Math.ceil(filtered.length / pageSize);
  const paginated  = filtered.slice((page - 1) * pageSize, page * pageSize);

  // reset to page 1 on search / size change
  useEffect(() => { setPage(1); }, [search, pageSize, sortKey]);

  // ─────────────────────────────────────────────────────────────────────────
  //  SELECTION HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  const pageIds     = useMemo(() => paginated.map((p) => p._id), [paginated]);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const someSelected = pageIds.some((id) => selectedIds.has(id));

  const toggleAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) pageIds.forEach((id) => next.delete(id));
      else             pageIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggleOne = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  DELETE (single)
  // ─────────────────────────────────────────────────────────────────────────

  const confirmDelete = (id) => { setDeleteTarget(id); setDeleteModalOpen(true); };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await fetch("/api/products", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: deleteTarget }),
      });
      setProducts((prev) => prev.filter((p) => p._id !== deleteTarget));
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(deleteTarget); return n; });
    } catch {}
    setDeleteModalOpen(false);
    setDeleteTarget(null);
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  BULK ACTIONS
  // ─────────────────────────────────────────────────────────────────────────

  const bulkUpdateCollections = async (addCol, removeCol) => {
    setBulkLoading(true);
    try {
      await Promise.all(
        [...selectedIds].map(async (id) => {
          const product = products.find((p) => p._id === id);
          if (!product) return;
          let cols = parseCollections(product.collections);
          if (addCol    && !cols.includes(addCol))    cols = [...cols, addCol];
          if (removeCol)                               cols = cols.filter((c) => c !== removeCol);
          await fetch("/api/products", {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ _id: id, collections: cols }),
          });
        })
      );
      await fetchProducts();
    } catch {}
    setBulkLoading(false);
    setSelectedIds(new Set());
  };

  const handleBulkAddCollection    = (col) => bulkUpdateCollections(col, null);
  const handleBulkRemoveCollection = (col) => bulkUpdateCollections(null, col);

  const handleBulkDelete = async () => {
    if (!window.confirm(`هل أنت متأكد من حذف ${selectedIds.size} منتج؟`)) return;
    setBulkLoading(true);
    try {
      await Promise.all(
        [...selectedIds].map((id) =>
          fetch("/api/products", {
            method: "DELETE", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ _id: id }),
          })
        )
      );
      setProducts((prev) => prev.filter((p) => !selectedIds.has(p._id)));
      setSelectedIds(new Set());
    } catch {}
    setBulkLoading(false);
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  DUPLICATE
  // ─────────────────────────────────────────────────────────────────────────

  const handleDuplicate = async (product) => {
    setDuplicating(product._id);
    try {
      await fetch("/api/products", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title:           `${product.title} (Copy)`,
          description:     product.description     || "",
          shortDescription:product.shortDescription|| "",
          regularPrice:    product.regularPrice,
          salePrice:       product.salePrice,
          costPerItem:     product.costPerItem,
          images:          Array.isArray(product.images) ? product.images : [],
          variants:        Array.isArray(product.variants) ? product.variants : [],
          collections:     parseCollections(product.collections),
          sku:             "",
          brand:           product.brand     || "",
          supplier:        product.supplier  || "",
          tags:            product.tags      || "",
          productLabel:    product.productLabel || "",
          stockStatus:     product.stockStatus || "In Stock",
          stockQuantity:   product.stockQuantity,
          status:          "Inactive",   // start inactive — admin reviews before going live
          isActive:        false,
          rating:          product.rating       || 0,
          ratingsCount:    product.ratingsCount || 0,
          reviewsCount:    product.reviewsCount || 0,
        }),
      });
      await fetchProducts();
    } catch {}
    setDuplicating(null);
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  SORT HEADER
  // ─────────────────────────────────────────────────────────────────────────

  const SortTh = ({ label, sk, className = "" }) => {
    const active = sortKey === sk;
    return (
      <th onClick={() => { if (active) setSortDir((d) => d === "desc" ? "asc" : "desc"); else { setSortKey(sk); setSortDir("desc"); } }}
        className={`text-right text-xs font-semibold text-gray-500 px-3 py-3 whitespace-nowrap cursor-pointer select-none hover:text-gray-700 ${className}`}>
        {label}
        {active && <span className="mr-1 opacity-60">{sortDir === "desc" ? "↓" : "↑"}</span>}
      </th>
    );
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  LOADING
  // ─────────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex justify-center items-center h-[calc(100vh-80px)]">
        <Loader2 className="w-8 h-8 animate-spin text-gray-300" />
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-full">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-row sm:items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">المنتجات</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {filtered.length} من {products.length} منتج
          </p>
        </div>
        <CustomButton
          as={Link} href="/admin/products/new"
          intent="primary" size="sm"
          startContent={<Plus className="w-4 h-4" />}
          tooltip="إضافة منتج جديد"
        >
          منتج جديد
        </CustomButton>
      </div>

      {/* ── Toolbar: Search + Page size ────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap bg-white rounded-2xl border border-gray-100 p-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث بالاسم أو المجموعة..."
            className="w-full pr-9 pl-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-gray-400 bg-gray-50"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1.5">
          <BarChart2 className="w-4 h-4 text-gray-400" />
          <select value={`${sortKey}-${sortDir}`}
            onChange={(e) => {
              const [sk, sd] = e.target.value.split("-");
              setSortKey(sk); setSortDir(sd);
            }}
            className="text-sm border border-gray-200 rounded-xl px-2.5 py-1.5 bg-gray-50 focus:outline-none focus:border-gray-400 text-gray-700">
            <option value="createdAt-desc">الأحدث أولاً</option>
            <option value="createdAt-asc">الأقدم أولاً</option>
            <option value="orders-desc">الأكثر طلباً</option>
            <option value="clicks-desc">الأكثر مشاهدة</option>
          </select>
        </div>

        {/* Page size */}
        <div className="flex items-center gap-1.5 mr-auto">
          <span className="text-xs text-gray-500 whitespace-nowrap">عرض:</span>
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}
            className="text-sm border border-gray-200 rounded-xl px-2.5 py-1.5 bg-gray-50 focus:outline-none focus:border-gray-400 text-gray-700">
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Bulk actions bar (visible when items selected) ──────────────── */}
      {selectedIds.size > 0 && (
        <BulkActionsBar
          count={selectedIds.size}
          collections={collections}
          onAddCollection={handleBulkAddCollection}
          onRemoveCollection={handleBulkRemoveCollection}
          onDelete={handleBulkDelete}
          onClear={() => setSelectedIds(new Set())}
          loading={bulkLoading}
        />
      )}

      {/* ── Table ───────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Package className="w-10 h-10 text-gray-200" />
            <p className="text-gray-400 text-sm">لا توجد منتجات</p>
          </div>
        ) : (
          <>
            {/* ── Mobile cards ──────────────────────────────────────────── */}
            <div className="block lg:hidden divide-y divide-gray-50">
              {paginated.map((product) => {
                const thumb   = firstImageSrc(product.images);
                const stats   = analytics[product._id] || { orders: 0, clicks: 0 };
                const isSel   = selectedIds.has(product._id);
                const isDup   = duplicating === product._id;
                const cols    = parseCollections(product.collections);

                return (
                  <div key={product._id}
                    className={`p-4 transition-colors ${isSel ? "bg-blue-50" : "hover:bg-gray-50"}`}>
                    <div className="flex items-start gap-3">
                      {/* Checkbox */}
                      <input type="checkbox" checked={isSel}
                        onChange={() => toggleOne(product._id)}
                        className="mt-1 w-4 h-4 accent-blue-600 cursor-pointer flex-shrink-0" />

                      {/* Thumb */}
                      {thumb
                        ? <img src={thumb} alt={product.title} className="w-12 h-12 rounded-xl object-cover border border-gray-100 flex-shrink-0" />
                        : <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
                            <Package className="w-5 h-5 text-gray-300" />
                          </div>
                      }

                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-gray-900 text-sm truncate">{product.title}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{fmt(product.salePrice || product.regularPrice)}</p>
                        {cols.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {cols.slice(0, 2).map((c) => (
                              <span key={c} className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded-md">{c}</span>
                            ))}
                          </div>
                        )}
                        <div className="flex items-center gap-3 mt-1.5">
                          <StatPill value={stats.orders} label="طلب" color="green" />
                          <StatPill value={stats.clicks} label="زيارة" color="blue" />
                          <span className="text-[11px] text-orange-600 font-semibold">
                            {ctr(stats.orders, stats.clicks)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <span className="text-[10px] text-gray-400">القفل:</span>
                          <ProductLockToggle compact locked={lockedIds.has(product._id)}
                            busy={lockBusy === product._id} onToggle={() => toggleProductLock(product._id)} />
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-col gap-1.5 flex-shrink-0">
                        <Link href={{ pathname: "/admin/products/new", query: { productId: product._id, isUpdate: true } }}>
                          <button className="p-2 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition-colors">
                            <Edit3 className="w-4 h-4" />
                          </button>
                        </Link>
                        <button onClick={() => handleDuplicate(product)} disabled={!!isDup}
                          className="p-2 bg-purple-50 text-purple-600 rounded-lg hover:bg-purple-100 transition-colors disabled:opacity-50">
                          {isDup ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />}
                        </button>
                        <button onClick={() => confirmDelete(product._id)}
                          className="p-2 bg-red-50 text-red-500 rounded-lg hover:bg-red-100 transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── Desktop table ──────────────────────────────────────────── */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {/* Select-all checkbox */}
                    <th className="px-3 py-3 w-10">
                      <input type="checkbox"
                        checked={allSelected} ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                        onChange={toggleAll}
                        className="w-4 h-4 accent-blue-600 cursor-pointer" />
                    </th>
                    <th className="text-right text-xs font-semibold text-gray-500 px-3 py-3 w-12">الصورة</th>
                    <th className="text-right text-xs font-semibold text-gray-500 px-3 py-3">المنتج</th>
                    <th className="text-right text-xs font-semibold text-gray-500 px-3 py-3 whitespace-nowrap">المجموعات</th>
                    <th className="text-right text-xs font-semibold text-gray-500 px-3 py-3 whitespace-nowrap">السعر</th>
                    <th className="text-right text-xs font-semibold text-gray-500 px-3 py-3 whitespace-nowrap">الحالة</th>
                    <th className="text-right text-xs font-semibold text-gray-500 px-3 py-3 whitespace-nowrap" title="مقفل: ظاهر في المتجر لكن لا يمكن فتحه أو شراؤه">القفل</th>
                    <SortTh label="📦 الطلبات" sk="orders" />
                    <SortTh label="👆 الزيارات" sk="clicks" />
                    <th className="text-right text-xs font-semibold text-gray-500 px-3 py-3 whitespace-nowrap">📊 CTR</th>
                    <th className="text-right text-xs font-semibold text-gray-500 px-3 py-3 whitespace-nowrap">التاريخ</th>
                    <th className="text-right text-xs font-semibold text-gray-500 px-3 py-3 whitespace-nowrap">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {paginated.map((product) => {
                    const thumb  = firstImageSrc(product.images);
                    const price  = product.salePrice || product.regularPrice;
                    const stats  = analytics[product._id] || { orders: 0, clicks: 0 };
                    const isSel  = selectedIds.has(product._id);
                    const isDup  = duplicating === product._id;
                    const cols   = parseCollections(product.collections);

                    return (
                      <tr key={product._id}
                        className={`transition-colors ${isSel ? "bg-blue-50 hover:bg-blue-100" : "hover:bg-gray-50"}`}>

                        {/* Checkbox */}
                        <td className="px-3 py-3">
                          <input type="checkbox" checked={isSel}
                            onChange={() => toggleOne(product._id)}
                            className="w-4 h-4 accent-blue-600 cursor-pointer" />
                        </td>

                        {/* Image */}
                        <td className="px-3 py-3">
                          {thumb
                            ? <img src={thumb} alt={product.title} className="w-10 h-10 rounded-xl object-cover border border-gray-100" />
                            : <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center">
                                <Package className="w-4 h-4 text-gray-300" />
                              </div>
                          }
                        </td>

                        {/* Title */}
                        <td className="px-3 py-3 max-w-[220px]">
                          <p className="font-semibold text-gray-900 truncate">{product.title}</p>
                          {product.shortDescription && (
                            <p className="text-xs text-gray-400 truncate">{product.shortDescription}</p>
                          )}
                        </td>

                        {/* Collections */}
                        <td className="px-3 py-3 max-w-[160px]">
                          {cols.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {cols.slice(0, 3).map((c) => (
                                <span key={c}
                                  className="text-[10px] bg-blue-50 text-blue-600 border border-blue-100 px-1.5 py-0.5 rounded-md whitespace-nowrap font-medium">
                                  {c}
                                </span>
                              ))}
                              {cols.length > 3 && (
                                <span className="text-[10px] text-gray-400">+{cols.length - 3}</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-gray-300">—</span>
                          )}
                        </td>

                        {/* Price */}
                        <td className="px-3 py-3 whitespace-nowrap">
                          <span className="font-semibold text-gray-900">{fmt(price)}</span>
                          {product.salePrice && product.regularPrice > product.salePrice && (
                            <span className="block text-xs text-gray-400 line-through">{fmt(product.regularPrice)}</span>
                          )}
                        </td>

                        {/* Status */}
                        <td className="px-3 py-3">
                          <StatusBadge status={product.status} />
                        </td>

                        {/* Product lock */}
                        <td className="px-3 py-3">
                          <ProductLockToggle locked={lockedIds.has(product._id)}
                            busy={lockBusy === product._id} onToggle={() => toggleProductLock(product._id)} />
                        </td>

                        {/* Orders */}
                        <td className="px-3 py-3 text-center">
                          <span className={`inline-flex items-center justify-center w-9 h-7 rounded-lg text-sm font-black
                            ${stats.orders > 0 ? "bg-green-50 text-green-700" : "text-gray-300"}`}>
                            {stats.orders}
                          </span>
                        </td>

                        {/* Clicks */}
                        <td className="px-3 py-3 text-center">
                          <span className={`inline-flex items-center justify-center w-9 h-7 rounded-lg text-sm font-black
                            ${stats.clicks > 0 ? "bg-blue-50 text-blue-700" : "text-gray-300"}`}>
                            {stats.clicks}
                          </span>
                        </td>

                        {/* CTR */}
                        <td className="px-3 py-3 text-center">
                          <span className={`text-sm font-bold
                            ${stats.clicks > 0 ? "text-orange-600" : "text-gray-300"}`}>
                            {ctr(stats.orders, stats.clicks)}
                          </span>
                        </td>

                        {/* Date */}
                        <td className="px-3 py-3 whitespace-nowrap">
                          <span className="text-xs text-gray-400">{formatDate(product.createdAt)}</span>
                        </td>

                        {/* Actions */}
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5">
                            {/* Edit */}
                            <Link href={{ pathname: "/admin/products/new", query: { productId: product._id, isUpdate: true } }}>
                              <button title="تعديل"
                                className="p-1.5 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition-colors">
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                            </Link>

                            {/* Duplicate */}
                            <button title="نسخ" onClick={() => handleDuplicate(product)} disabled={!!isDup}
                              className="p-1.5 bg-purple-50 text-purple-600 rounded-lg hover:bg-purple-100 transition-colors disabled:opacity-50">
                              {isDup
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <Copy className="w-3.5 h-3.5" />
                              }
                            </button>

                            {/* Delete */}
                            <button title="حذف" onClick={() => confirmDelete(product._id)}
                              className="p-1.5 bg-red-50 text-red-500 rounded-lg hover:bg-red-100 transition-colors">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* ── Footer: info + pagination ──────────────────────────────── */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between gap-4 px-4 py-3 border-t border-gray-100 flex-wrap">
                <p className="text-xs text-gray-400">
                  صفحة {page} من {totalPages} ·{" "}
                  {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, filtered.length)} من {filtered.length}
                </p>
                <PaginationBar page={page} total={totalPages} onChange={setPage} />
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Delete confirmation modal ────────────────────────────────────── */}
      <DeleteConfirmationModal
        isOpen={deleteModalOpen}
        onClose={() => { setDeleteModalOpen(false); setDeleteTarget(null); }}
        onConfirm={handleDelete}
      />
    </div>
  );
}
