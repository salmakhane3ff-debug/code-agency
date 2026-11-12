"use client";

import { useState, useEffect, useMemo } from "react";
import { Wallet, Loader2, Check, X, Search, Eye, AlertTriangle, Power } from "lucide-react";

const STATUS_STYLE = {
  PENDING:  { label: "En attente", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  APPROVED: { label: "Approuvé", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  REJECTED: { label: "Refusé", cls: "bg-red-50 text-red-700 border-red-200" },
};

function StatusBadge({ status }) {
  const s = STATUS_STYLE[status] || { label: status, cls: "bg-gray-50 text-gray-600 border-gray-200" };
  return <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold border ${s.cls}`}>{s.label}</span>;
}

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}
const fmtMoney = (n) => `${Number(n || 0).toFixed(0)} MAD`;

/**
 * Admin switch "Recharge de solde des Affiliés" (GET / PUT /api/admin/affiliate-recharge, revisioned).
 * OFF only hides the affiliate recharge UI and refuses NEW recharge requests: the requests listed
 * below stay reviewable, and balances / Create Your Own Brand / commissions / rewards / withdrawals
 * are not affected.
 */
function RechargeSwitchCard() {
  const [setting, setSetting] = useState(null);   // { enabled, isDefault, updatedAt, updatedBy, updatedByName, revision }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [askOff, setAskOff]   = useState(false);  // inline confirmation before turning OFF
  const [msg, setMsg]         = useState(null);   // { kind: "error" | "ok", text }

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/affiliate-recharge", { cache: "no-store" });
      const d = await res.json().catch(() => null);
      if (res.ok && d && typeof d.enabled === "boolean") setSetting(d);
      else setMsg({ kind: "error", text: d?.error || "Impossible de charger le réglage." });
    } catch {
      setMsg({ kind: "error", text: "Impossible de charger le réglage (réseau)." });
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async (enabled) => {
    if (!setting || saving) return;
    setSaving(true); setMsg(null);
    try {
      const res = await fetch("/api/admin/affiliate-recharge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, revision: setting.revision }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d && typeof d.enabled === "boolean") {
        setSetting(d); setAskOff(false);
        setMsg({ kind: "ok", text: d.enabled ? "Recharge de solde activée." : "Recharge de solde désactivée." });
      } else if (res.status === 409 && d?.code === "SETTINGS_CONFLICT") {
        // Someone else saved first: nothing was written — show the current state.
        if (d.current && typeof d.current.enabled === "boolean") setSetting(d.current); else await load();
        setAskOff(false);
        const now = d.current ? (d.current.enabled ? "Activée" : "Désactivée") : null;
        setMsg({ kind: "error", text: `${d.error || "Ce réglage a été modifié entre-temps."}${now ? ` État actuel : ${now}.` : ""}` });
      } else {
        setMsg({ kind: "error", text: d?.error || "Enregistrement impossible." });
      }
    } catch {
      setMsg({ kind: "error", text: "Enregistrement impossible (réseau)." });
    } finally { setSaving(false); }
  };

  const enabled = setting ? setting.enabled : true;
  const onToggle = () => { if (!setting || saving) return; if (enabled) setAskOff(true); else save(true); };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 space-y-3" data-recharge-switch>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <Power className={`w-5 h-5 mt-0.5 shrink-0 ${enabled ? "text-emerald-600" : "text-gray-400"}`} />
          <div className="min-w-0">
            <h2 className="text-base font-bold text-gray-900">Recharge de solde des Affiliés</h2>
            {loading && !setting ? (
              <p className="text-xs text-gray-400 mt-0.5">Chargement…</p>
            ) : setting ? (
              <p className="text-xs text-gray-500 mt-0.5">
                État : <strong className={enabled ? "text-emerald-700" : "text-red-600"}>{enabled ? "Activée" : "Désactivée"}</strong>
                {setting.isDefault ? " (par défaut)" : ""}
                {setting.updatedAt && <> · Dernière modification : {fmtDate(setting.updatedAt)}{setting.updatedBy ? <> par <span data-updated-by>{setting.updatedByName || "Administrateur"}</span></> : null}</>}
              </p>
            ) : null}
          </div>
        </div>
        <button type="button" role="switch" aria-checked={enabled} aria-label="Recharge de solde des Affiliés"
          disabled={!setting || saving} onClick={onToggle}
          className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 ${enabled ? "bg-emerald-500" : "bg-gray-300"}`}>
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${enabled ? "left-[22px]" : "left-0.5"}`} />
        </button>
      </div>

      <div className="text-xs text-gray-600 space-y-1">
        <p><strong>Désactivée :</strong> les affiliés ne voient plus le widget de recharge ni l&apos;onglet « Recharge de solde », et les nouvelles demandes de recharge sont refusées.</p>
        <p>Les demandes déjà envoyées restent ici et peuvent toujours être validées ou refusées. Les soldes, les recharges déjà créditées, les paiements Create Your Own Brand, les commissions, les récompenses et les retraits ne sont pas affectés.</p>
        <p><strong>Réactivée :</strong> tout revient comme avant, rien n&apos;est perdu.</p>
      </div>

      {askOff && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-amber-800 flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" /> Désactiver la recharge de solde pour tous les affiliés ?
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setAskOff(false)} disabled={saving}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white text-gray-600 border border-gray-200 hover:bg-gray-100">Annuler</button>
            <button type="button" onClick={() => save(false)} disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Désactiver
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p role={msg.kind === "error" ? "alert" : "status"} className={`text-xs font-semibold ${msg.kind === "error" ? "text-red-600" : "text-emerald-700"}`}>{msg.text}</p>
      )}
    </div>
  );
}

export default function AdminDepositsPage() {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId]   = useState(null);
  const [filter, setFilter]   = useState("PENDING");
  const [search, setSearch]   = useState("");
  const [preview, setPreview] = useState(null);   // deposit id
  const [confirm, setConfirm] = useState(null);   // { id, action, row }
  const [reason, setReason]   = useState("");

  const load = () => {
    setLoading(true);
    fetch("/api/admin/deposits")
      .then((r) => r.json())
      .then((d) => setRows(Array.isArray(d) ? d : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const counts = useMemo(() => ({
    ALL: rows.length,
    PENDING: rows.filter((r) => r.status === "PENDING").length,
    APPROVED: rows.filter((r) => r.status === "APPROVED").length,
    REJECTED: rows.filter((r) => r.status === "REJECTED").length,
  }), [rows]);

  const displayed = useMemo(() => {
    let list = rows;
    if (filter !== "ALL") list = list.filter((r) => r.status === filter);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((r) =>
      r.affiliateName?.toLowerCase().includes(q) ||
      r.username?.toLowerCase().includes(q) ||
      r.phone?.includes(q) ||
      r.affiliateId?.toLowerCase().includes(q));
    return list;
  }, [rows, filter, search]);

  const act = async (id, action, reasonText) => {
    setBusyId(id);
    try {
      const res = await fetch("/api/admin/deposits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, reason: reasonText }),
      });
      if (res.ok) { setConfirm(null); setReason(""); load(); }
    } finally { setBusyId(null); }
  };

  return (
    <div className="py-6 max-w-6xl space-y-5">
      <div className="flex items-center gap-3">
        <Wallet className="w-6 h-6 text-indigo-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">💰 Dépôts de solde</h1>
          <p className="text-sm text-gray-500">{displayed.length} / {rows.length} demande(s)</p>
        </div>
      </div>

      <RechargeSwitchCard />

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex flex-wrap gap-2 items-center">
        {["PENDING", "APPROVED", "REJECTED", "ALL"].map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${filter === s ? "bg-gray-900 text-white border-gray-900" : "bg-gray-50 text-gray-600 border-gray-200"}`}>
            {s === "ALL" ? "Tous" : STATUS_STYLE[s].label} ({counts[s]})
          </button>
        ))}
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Nom, username, téléphone, ID…"
            className="w-full pr-9 pl-3 py-2 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400" />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-7 h-7 animate-spin text-gray-400" /></div>
      ) : displayed.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 py-16 text-center text-gray-400 text-sm">Aucune demande</div>
      ) : (
        <div className="space-y-3">
          {displayed.map((r) => (
            <div key={r.id} className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-gray-900">{r.affiliateName || "—"}</span>
                    <span className="text-sm text-gray-500">@{r.username}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <p className="text-xs text-gray-500 mt-1 break-words">
                    📞 {r.phone || "—"} · ID <span className="font-mono">{r.affiliateId?.slice(0, 8)}</span> · {fmtDate(r.createdAt)}
                    {r.reviewedAt && <> · Revu {fmtDate(r.reviewedAt)}</>}
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-600">
                    <span className="font-bold text-gray-900 text-sm">{fmtMoney(r.amount)}</span>
                    <span>Méthode : {r.paymentMethod}</span>
                    {r.transferReference && <span>Réf : {r.transferReference}</span>}
                  </div>
                  {r.affiliateNote && <p className="text-xs text-gray-400 mt-1">Note : {r.affiliateNote}</p>}
                  {r.status === "REJECTED" && r.rejectionReason && (
                    <p className="text-xs text-red-600 mt-1">Motif du refus : {r.rejectionReason}</p>
                  )}
                </div>
                <button onClick={() => setPreview(r.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-gray-50 text-gray-700 border border-gray-200 hover:bg-gray-100 shrink-0">
                  <Eye className="w-3.5 h-3.5" /> Voir la preuve
                </button>
              </div>

              {r.status === "PENDING" && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button disabled={busyId === r.id} onClick={() => { setConfirm({ id: r.id, action: "approve", row: r }); setReason(""); }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                    <Check className="w-3.5 h-3.5" /> Approuver
                  </button>
                  <button disabled={busyId === r.id} onClick={() => { setConfirm({ id: r.id, action: "reject", row: r }); setReason(""); }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-white text-red-600 border border-red-200 hover:bg-red-50">
                    <X className="w-3.5 h-3.5" /> Refuser
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Confirm dialog */}
      {confirm && (() => {
        const rejecting = confirm.action === "reject";
        const canSubmit = !rejecting || reason.trim().length > 0;
        return (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => busyId ? null : setConfirm(null)}>
            <div className="bg-white rounded-2xl w-full max-w-md p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
                <h3 className="text-base font-bold text-gray-900">
                  {rejecting ? "Refuser le dépôt" : "Approuver le dépôt"}
                </h3>
              </div>
              <p className="text-sm text-gray-500 mb-3">
                {rejecting
                  ? "Indiquez le motif du refus (visible par l'affilié). Aucun solde ne change."
                  : `Créditer ${fmtMoney(confirm.row?.amount)} au solde disponible de @${confirm.row?.username} ?`}
              </p>
              {rejecting && (
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus
                  placeholder="Motif du refus (obligatoire)…"
                  className="w-full text-sm border border-gray-200 rounded-lg p-2 h-24 mb-3 focus:outline-none focus:border-gray-400" />
              )}
              <div className="flex justify-end gap-2">
                <button onClick={() => setConfirm(null)} disabled={busyId === confirm.id}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-gray-100 text-gray-600 hover:bg-gray-200">Annuler</button>
                <button disabled={!canSubmit || busyId === confirm.id}
                  onClick={() => act(confirm.id, confirm.action, reason)}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white disabled:opacity-50 ${rejecting ? "bg-red-600 hover:bg-red-700" : "bg-emerald-600 hover:bg-emerald-700"}`}>
                  {busyId === confirm.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  {rejecting ? "Confirmer le refus" : "Approuver"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Proof lightbox — images inline; PDFs in an iframe */}
      {preview && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <button className="absolute top-4 right-4 text-white/80 hover:text-white" onClick={() => setPreview(null)}><X className="w-7 h-7" /></button>
          <div className="max-w-full max-h-full w-full sm:w-[80%] h-[85%] bg-white rounded-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <iframe src={`/api/admin/deposits/${preview}/proof`} title="Preuve" className="w-full h-full" />
          </div>
        </div>
      )}
    </div>
  );
}
