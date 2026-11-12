"use client";

/**
 * Management list of payment proofs: status filters with counts, paging, receipt
 * preview, edit / cancel before publication, and the audit history of each proof.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Pencil, Ban, History, ChevronLeft, ChevronRight, Send } from "lucide-react";
import {
  inputCls, btnPrimary, btnGhost, btnDanger, api, apiErrorText, errText, fmtInstant, fmtMad, StatusBadge, STATUS_META,
  FAILURE_TEXT, EVENT_TEXT, Modal, Declarations, dayLabel, scheduleProblem,
} from "./ui";

const FILTERS = [
  { id: "ALL", label: "Tout" },
  { id: "SCHEDULED", label: STATUS_META.SCHEDULED.label },
  { id: "PUBLISHED", label: STATUS_META.PUBLISHED.label },
  { id: "CANCELLED", label: STATUS_META.CANCELLED.label },
  { id: "FAILED", label: STATUS_META.FAILED.label },
];
const EDITABLE = ["SCHEDULED", "FAILED"];
const imageUrl = (id) => `/api/admin/payment-proofs/${encodeURIComponent(id)}/image`;

function EditDialog({ proof, onClose, onSaved }) {
  const [f, setF] = useState({
    displayName: proof.displayName, amount: String(proof.amount ?? ""),
    date: proof.scheduledLocal?.date || "", time: proof.scheduledLocal?.time || "", privacy: false, authenticity: false,
  });
  const [errors, setErrors] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const save = async () => {
    const early = scheduleProblem(f.date, f.time); // same rule as the server, answered at once
    if (early) { setErrors({ scheduledAt: early }); setMsg(null); return; }
    setBusy(true); setMsg(null); setErrors({});
    const res = await api(`/api/admin/payment-proofs/${encodeURIComponent(proof.id)}`, {
      method: "PATCH",
      body: { displayName: f.displayName, amount: f.amount, date: f.date, time: f.time, privacyConfirmed: f.privacy, authenticityConfirmed: f.authenticity },
    });
    setBusy(false);
    if (res.ok) { onSaved(); return; }
    if (res.data?.errors) setErrors(res.data.errors);
    setMsg(apiErrorText(res));
  };
  const fieldErr = (k) => (errors[k] ? <span className="block text-[11px] text-red-600">{errText(String(errors[k]))}</span> : null);
  return (
    <Modal title="Modifier la preuve" onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-[11px] font-semibold text-gray-600">Nom affiché</span>
          <input className={inputCls} maxLength={40} value={f.displayName} onChange={(e) => set({ displayName: e.target.value })} />
          {fieldErr("displayName")}
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-gray-600">Montant (MAD)</span>
          <input className={inputCls} inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} />
          {fieldErr("amount")}
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block min-w-0">
            <span className="text-[11px] font-semibold text-gray-600">Date (Maroc)</span>
            <input type="date" className={inputCls} value={f.date} onChange={(e) => set({ date: e.target.value })} />
          </label>
          <label className="block min-w-0">
            <span className="text-[11px] font-semibold text-gray-600">Heure (heure du Maroc)</span>
            <input type="time" className={inputCls} value={f.time} onChange={(e) => set({ time: e.target.value })} />
          </label>
        </div>
        {fieldErr("scheduledAt")}
        <p className="text-[11px] text-gray-500">Confirmez à nouveau les deux déclarations pour enregistrer la modification.</p>
        <Declarations idPrefix={`edit-${proof.id}`} privacy={f.privacy} authenticity={f.authenticity} onChange={set} />
        {fieldErr("privacyConfirmed")}{fieldErr("authenticityConfirmed")}
        {msg && <p role="alert" className="text-xs text-red-600 break-words">{msg}</p>}
        <div className="flex flex-wrap gap-2 justify-end">
          <button type="button" className={btnGhost} onClick={onClose}>Fermer</button>
          <button type="button" className={btnPrimary} onClick={save} disabled={busy || !f.privacy || !f.authenticity}>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Enregistrer
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CancelDialog({ proof, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const go = async () => {
    setBusy(true); setMsg(null);
    const res = await api(`/api/admin/payment-proofs/${encodeURIComponent(proof.id)}`, { method: "POST", body: { action: "cancel" } });
    setBusy(false);
    if (res.ok) onDone(); else setMsg(apiErrorText(res));
  };
  return (
    <Modal title="Annuler la preuve" onClose={onClose}>
      <p className="text-sm text-gray-700 break-words">
        Annuler « {proof.displayName} » ({fmtMad(proof.amount)}) ? Elle ne sera jamais publiée. L&apos;enregistrement est conservé dans l&apos;historique.
      </p>
      {msg && <p role="alert" className="mt-2 text-xs text-red-600 break-words">{msg}</p>}
      <div className="mt-4 flex flex-wrap gap-2 justify-end">
        <button type="button" className={btnGhost} onClick={onClose}>Retour</button>
        <button type="button" className={btnDanger} onClick={go} disabled={busy}>{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Annuler la preuve</button>
      </div>
    </Modal>
  );
}

/**
 * "Publier maintenant" for a scheduled proof (before its planned time): explicit confirmation, then the
 * server publishes it through the same pipeline as the worker (publishedAt = the server time then).
 */
function PublishNowDialog({ proof, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [done, setDone] = useState(null);
  const go = async () => {
    setBusy(true); setMsg(null);
    const res = await api(`/api/admin/payment-proofs/${encodeURIComponent(proof.id)}`, { method: "POST", body: { action: "publish_now" } });
    setBusy(false);
    if (res.ok) setDone(res.data); else setMsg(apiErrorText(res));
  };
  return (
    <Modal title="Publier maintenant" onClose={done || msg ? onDone : onClose}>
      {done ? (
        <div className="space-y-3" data-publish-now-result="published">
          <p className="text-sm text-emerald-700 font-semibold">
            {done.alreadyPublished ? "Cette preuve était déjà publiée" : "Preuve publiée"} — le {fmtInstant(done.publication?.publishedAt || done.proof?.publishedAt)} (heure du Maroc).
          </p>
          <p className="text-[11px] text-gray-500">Visible par tous les affiliés actifs pendant 72 h à partir de cette heure.</p>
          <div className="flex justify-end"><button type="button" className={btnPrimary} onClick={onDone} autoFocus>Fermer</button></div>
        </div>
      ) : (
        <div className="space-y-3" data-publish-now-dialog>
          <p className="text-sm text-gray-700 break-words">
            Publier « {proof.displayName} » ({fmtMad(proof.amount)}) <strong>maintenant</strong>, avant l&apos;heure prévue
            ({proof.scheduledLocal ? `${dayLabel(proof.scheduledLocal.date)} à ${proof.scheduledLocal.time}` : "—"}, heure du Maroc) ?
          </p>
          <p className="text-[11px] text-gray-500">Elle sera visible immédiatement par tous les affiliés actifs, pendant 72 h à partir de sa publication effective. La publication programmée ne la publiera pas une seconde fois.</p>
          {msg && <p role="alert" className="text-xs text-red-600 break-words" data-publish-now-error>{msg}</p>}
          <div className="flex flex-wrap gap-2 justify-end">
            <button type="button" className={btnGhost} onClick={msg ? onDone : onClose}>{msg ? "Fermer" : "Retour"}</button>
            {!msg && (
              <button type="button" className={btnPrimary} onClick={go} disabled={busy} data-publish-now-confirm>
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}Publier maintenant
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function HistoryDialog({ proof, onClose }) {
  const [state, setState] = useState({ loading: true, events: [], error: null });
  useEffect(() => {
    let alive = true;
    api(`/api/admin/payment-proofs/${encodeURIComponent(proof.id)}/events`).then((res) => {
      if (alive) setState({ loading: false, events: res.ok ? res.data?.events || [] : [], error: res.ok ? null : apiErrorText(res) });
    });
    return () => { alive = false; };
  }, [proof.id]);
  return (
    <Modal title={`Historique — ${proof.displayName}`} onClose={onClose}>
      {state.loading && <p className="text-xs text-gray-500 inline-flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" />Chargement…</p>}
      {state.error && <p role="alert" className="text-xs text-red-600">{state.error}</p>}
      <ol className="space-y-2">
        {state.events.map((e, i) => (
          <li key={`${e.at}-${i}`} className="rounded-xl border border-gray-100 bg-gray-50 p-2.5 text-xs text-gray-700 min-w-0">
            <p className="font-semibold text-gray-900">
              {e.details?.mode === "IMMEDIATE" ? `${EVENT_TEXT[e.action] || e.action} — immédiate (Publier maintenant)` : EVENT_TEXT[e.action] || e.action}
            </p>
            <p className="text-gray-500 break-all">{fmtInstant(e.at)} · {e.actor}</p>
            {e.details && <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] text-gray-600">{JSON.stringify(e.details, null, 1)}</pre>}
          </li>
        ))}
      </ol>
    </Modal>
  );
}

export default function ProofsList() {
  const [filter, setFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null); // { kind: 'preview' | 'edit' | 'cancel' | 'publish' | 'history', proof }

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const res = await api(`/api/admin/payment-proofs?status=${filter}&page=${page}`);
    setLoading(false);
    if (res.ok) setData(res.data); else setError(apiErrorText(res));
  }, [filter, page]);
  useEffect(() => { load(); }, [load]);

  const counts = data?.counts || {};
  const totalAll = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const closeAndReload = () => { setDialog(null); load(); };

  return (
    <div className="space-y-3 min-w-0">
      <div className="rounded-2xl border border-gray-200 bg-white p-3 text-[11px] text-gray-500 space-y-0.5 break-words">
        <p>• Une preuve publiée est visible par <strong>tous les affiliés actifs</strong> (le même slider pour tous) pendant 72 h à partir de sa publication effective, puis elle disparaît du slider (elle reste ici).</p>
        <p>• Le nom et le montant sont des données d&apos;affichage saisies par l&apos;administrateur : ils ne sont liés à aucun compte ni à aucun paiement.</p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((x) => (
          <button key={x.id} type="button" aria-pressed={filter === x.id} onClick={() => { setFilter(x.id); setPage(1); }}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${filter === x.id ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"}`}>
            {x.label} ({x.id === "ALL" ? totalAll : counts[x.id] ?? 0})
          </button>
        ))}
        <button type="button" className={`${btnGhost} ml-auto`} onClick={load} disabled={loading} aria-label="Actualiser">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />Actualiser
        </button>
      </div>

      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      {!loading && data && data.items.length === 0 && <p className="text-sm text-gray-500 py-6 text-center">Aucune preuve.</p>}

      <ul className="space-y-2">
        {(data?.items || []).map((p) => (
          <li key={p.id} className="rounded-2xl border border-gray-200 bg-white p-3 flex items-start gap-3 min-w-0">
            <button type="button" onClick={() => setDialog({ kind: "preview", proof: p })} aria-label={`Voir le reçu de ${p.displayName}`}
              className="w-16 h-16 rounded-lg border border-gray-200 bg-gray-50 overflow-hidden shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl(p.id)} alt="" loading="lazy" className="w-full h-full object-cover" />
            </button>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <p className="text-sm font-bold text-gray-900 break-words min-w-0">{p.displayName}</p>
                <span className="text-sm font-semibold text-gray-700">{fmtMad(p.amount)}</span>
                <StatusBadge status={p.status} />
              </div>
              <p className="text-[11px] text-gray-500 break-words">
                {p.publishedImmediately ? (
                  // "Publier maintenant": only the actual publication time is relevant (no planned time).
                  <span data-published-immediately>Publiée : <span data-published-at>{fmtInstant(p.publishedAt)}</span> (heure du Maroc) · publication immédiate</span>
                ) : (
                  <>
                    <span data-scheduled-at>Programmée : <span className="capitalize">{p.scheduledLocal ? `${dayLabel(p.scheduledLocal.date)} à ${p.scheduledLocal.time}` : "—"}</span> (heure du Maroc)</span>
                    {p.publishedAt && <> · Publiée : <span data-published-at>{fmtInstant(p.publishedAt)}</span> (heure du Maroc)</>}
                  </>
                )}
                {p.cancelledAt && <> · Annulée : {fmtInstant(p.cancelledAt)}</>}
              </p>
              {p.status === "FAILED" && (
                <p className="text-[11px] text-red-600 break-words">Échec : {FAILURE_TEXT[p.failureReason] || p.failureReason || "—"} · {fmtInstant(p.failedAt)}</p>
              )}
              <p className="text-[11px] text-gray-400">Tentatives de publication : {p.publishAttempts ?? 0}</p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {p.status === "SCHEDULED" && (
                  <button type="button" className={btnPrimary} onClick={() => setDialog({ kind: "publish", proof: p })} data-publish-now={p.id}>
                    <Send className="w-3.5 h-3.5" />Publier maintenant
                  </button>
                )}
                {EDITABLE.includes(p.status) && (
                  <>
                    <button type="button" className={btnGhost} onClick={() => setDialog({ kind: "edit", proof: p })}><Pencil className="w-3.5 h-3.5" />Modifier</button>
                    <button type="button" className={btnDanger} onClick={() => setDialog({ kind: "cancel", proof: p })}><Ban className="w-3.5 h-3.5" />Annuler</button>
                  </>
                )}
                <button type="button" className={btnGhost} onClick={() => setDialog({ kind: "history", proof: p })}><History className="w-3.5 h-3.5" />Historique</button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {data && pages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button type="button" className={btnGhost} disabled={page <= 1 || loading} onClick={() => setPage((n) => n - 1)} aria-label="Page précédente"><ChevronLeft className="w-4 h-4" /></button>
          <span className="text-xs text-gray-600">Page {page} / {pages} · {data.total} preuve{data.total > 1 ? "s" : ""}</span>
          <button type="button" className={btnGhost} disabled={page >= pages || loading} onClick={() => setPage((n) => n + 1)} aria-label="Page suivante"><ChevronRight className="w-4 h-4" /></button>
        </div>
      )}

      {dialog?.kind === "preview" && (
        <Modal title={`${dialog.proof.displayName} — ${fmtMad(dialog.proof.amount)}`} onClose={() => setDialog(null)} wide>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl(dialog.proof.id)} alt={`Reçu — ${dialog.proof.displayName}`} className="w-full max-h-[75vh] object-contain rounded-lg bg-gray-50" />
        </Modal>
      )}
      {dialog?.kind === "edit" && <EditDialog proof={dialog.proof} onClose={() => setDialog(null)} onSaved={closeAndReload} />}
      {dialog?.kind === "cancel" && <CancelDialog proof={dialog.proof} onClose={() => setDialog(null)} onDone={closeAndReload} />}
      {dialog?.kind === "publish" && <PublishNowDialog proof={dialog.proof} onClose={() => setDialog(null)} onDone={closeAndReload} />}
      {dialog?.kind === "history" && <HistoryDialog proof={dialog.proof} onClose={() => setDialog(null)} />}
    </div>
  );
}
