"use client";
/**
 * /admin/recruiter-identity — recruiter identity verification (KYC) review (Phase 6 part 3c).
 *
 *   • GET /api/admin/recruiter-identity             → queue + each recruiter's KYC history
 *   • PUT /api/admin/recruiter-identity             → { id, action, expectedStatus, submission, reason }
 *   • GET /api/admin/recruiter-identity/[id]/[side] → CIN image (private, no-store)
 * Images are fetched with the admin session into a blob URL (revoked when closed / replaced /
 * on unmount) — never a public URL. A decision names the status and submission shown, so an
 * outdated screen can never overwrite a newer upload (409 → reload). A REJECTED submission can
 * only be approved after the recruiter uploads new documents. Errors are always shown.
 * A recruiter withdrawal can be requested / paid only while the KYC is APPROVED.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, Eye, Loader2, RefreshCw, ShieldAlert, ShieldCheck, X, XCircle } from "lucide-react";

const REASON_MAX = 500;
const STATUS_UI = {
  PENDING: { label: "En attente", cls: "bg-amber-100 text-amber-800", Icon: Clock },
  APPROVED: { label: "Approuvée", cls: "bg-emerald-100 text-emerald-800", Icon: ShieldCheck },
  REJECTED: { label: "Rejetée", cls: "bg-red-100 text-red-700", Icon: ShieldAlert },
};
const ACTION_LABEL = {
  RECRUITER_IDENTITY_SUBMITTED: "Envoi du recruteur",
  RECRUITER_IDENTITY_APPROVED: "Approuvée par un admin",
  RECRUITER_IDENTITY_REJECTED: "Rejetée par un admin",
};
const fmt = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";
};

/** The CIN images of one row, fetched with the admin session into blob URLs (revoked on close). */
function CinViewer({ row, onClose }) {
  const [urls, setUrls] = useState({ front: "", back: "" });
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    const made = [];
    (async () => {
      try {
        const out = {};
        for (const side of ["front", "back"]) {
          const res = await fetch(`/api/admin/recruiter-identity/${encodeURIComponent(row.id)}/${side}`, { credentials: "include", cache: "no-store" });
          if (!res.ok) throw new Error(String(res.status));
          const u = URL.createObjectURL(await res.blob());
          made.push(u);
          out[side] = u;
        }
        if (alive) setUrls(out);
      } catch {
        if (alive) setErr("Impossible de charger les images.");
      }
    })();
    return () => { alive = false; for (const u of made) URL.revokeObjectURL(u); };
  }, [row.id]);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3" role="dialog" aria-modal="true" aria-label="Pièce d'identité" data-cin-viewer>
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[92vh] overflow-auto p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-bold text-gray-800 min-w-0 truncate">CIN — @{row.recruiterUsername} (envoi n°{row.submission})</h3>
          <button type="button" onClick={onClose} className="shrink-0 p-2 rounded-lg hover:bg-gray-100" aria-label="Fermer" data-cin-close><X size={18} /></button>
        </div>
        {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2" data-cin-error>{err}</p>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {["front", "back"].map((side) => (
            <figure key={side} className="min-w-0 space-y-1">
              <figcaption className="text-xs font-semibold text-gray-500">{side === "front" ? "Recto" : "Verso"}</figcaption>
              {urls[side]
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={urls[side]} alt={side === "front" ? "CIN recto" : "CIN verso"} className="w-full h-auto rounded-xl border border-gray-200" data-cin-image={side} />
                : !err && <div className="h-48 rounded-xl bg-gray-100 flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div>}
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}

function RejectForm({ row, busy, onSubmit, onCancel }) {
  const [reason, setReason] = useState("");
  const clean = reason.replace(/\s+/g, " ").trim();
  return (
    <div className="rounded-xl border border-red-200 bg-red-50/50 p-3 space-y-2" data-reject-form>
      <label htmlFor={`reason-${row.id}`} className="block text-xs font-semibold text-gray-700">
        Motif du {row.status === "APPROVED" ? "retrait de l'approbation" : "rejet"} (visible par le recruteur, 1–{REASON_MAX} caractères)
      </label>
      <textarea id={`reason-${row.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={REASON_MAX} rows={3}
        className="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" data-reject-reason />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-gray-500">{clean.length}/{REASON_MAX}</span>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-white">Annuler</button>
          <button type="button" onClick={() => onSubmit(clean)} disabled={busy || clean.length < 1 || clean.length > REASON_MAX} data-reject-confirm
            className="rounded-lg bg-red-600 text-white px-3 py-1.5 text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
            {row.status === "APPROVED" ? "Retirer l'approbation" : "Rejeter"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminRecruiterIdentityPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState("PENDING");
  const [busyId, setBusyId] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(null);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/recruiter-identity", { credentials: "include", cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!aliveRef.current) return;
      if (!res.ok) { setError(typeof body?.error === "string" ? body.error : "Erreur de chargement."); return; }
      setRows(Array.isArray(body?.verifications) ? body.verifications : []);
    } catch {
      if (aliveRef.current) setError("Erreur réseau.");
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);
  useEffect(() => { aliveRef.current = true; load(); return () => { aliveRef.current = false; }; }, [load]);

  const decide = async (row, action, reason) => {
    setBusyId(row.id);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/admin/recruiter-identity", {
        method: "PUT", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, action, expectedStatus: row.status, submission: row.submission, ...(action === "reject" ? { reason } : {}) }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof body?.error === "string" ? body.error : "Erreur lors de la décision.");
        if (res.status === 409) await load();
        return;
      }
      setRejecting(null);
      setMessage(action === "approve" ? `Identité de @${row.recruiterUsername} approuvée.` : `Identité de @${row.recruiterUsername} rejetée.`);
      await load();
    } catch {
      setError("Erreur réseau.");
    } finally {
      setBusyId(null);
    }
  };

  const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {});
  const shown = filter === "ALL" ? rows : rows.filter((r) => r.status === filter);

  return (
    <div className="py-6 max-w-5xl space-y-5 min-w-0" data-admin-recruiter-identity>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-gray-800">🪪 Identité des recruteurs</h1>
          <p className="text-sm text-gray-500">Un retrait recruteur ne peut être demandé ni payé que si l&apos;identité est approuvée.</p>
        </div>
        <button type="button" onClick={load} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-60" data-reload>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Actualiser
        </button>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filtrer par statut">
        {[["PENDING", "En attente"], ["APPROVED", "Approuvées"], ["REJECTED", "Rejetées"], ["ALL", "Toutes"]].map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)} data-filter={k}
            className={`rounded-full px-3 py-1 text-sm font-semibold border ${filter === k ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"}`}>
            {label} ({k === "ALL" ? rows.length : counts[k] ?? 0})
          </button>
        ))}
      </div>

      {error && <div role="alert" className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3 text-sm text-red-700" data-error>{error}</div>}
      {message && <div role="status" className="bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-3 text-sm text-emerald-800" data-message>{message}</div>}

      {loading && rows.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={16} className="animate-spin" /> Chargement…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-gray-400" data-empty>Aucune vérification.</p>
      ) : (
        <ul className="space-y-3">
          {shown.map((r) => {
            const st = STATUS_UI[r.status] ?? STATUS_UI.PENDING;
            const busy = busyId === r.id;
            return (
              <li key={r.id} className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 space-y-3 min-w-0" data-identity-row={r.id} data-identity-status={r.status}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-800 break-words">{r.recruiterName || "—"}</p>
                    <p className="text-xs text-gray-400 font-mono break-all">@{r.recruiterUsername}{r.recruiterActive ? "" : " · compte désactivé"}</p>
                  </div>
                  <span className={`inline-flex items-center gap-1 text-xs font-bold rounded-full px-2.5 py-1 ${st.cls}`}>
                    <st.Icon size={14} /> {st.label}
                  </span>
                </div>
                <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs text-gray-600">
                  <div><dt className="inline text-gray-400">Envoi n° </dt><dd className="inline font-semibold" data-submission>{r.submission}</dd></div>
                  <div><dt className="inline text-gray-400">Envoyé le </dt><dd className="inline">{fmt(r.submittedAt)}</dd></div>
                  <div><dt className="inline text-gray-400">Décision le </dt><dd className="inline">{fmt(r.reviewedAt)}</dd></div>
                </dl>
                {r.status === "REJECTED" && r.rejectionReason && (
                  <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2 break-words" data-rejection-reason>Motif : {r.rejectionReason}</p>
                )}
                {r.status === "REJECTED" && (
                  <p className="text-xs text-gray-500">En attente d&apos;un nouvel envoi du recruteur (une demande rejetée ne peut pas être approuvée directement).</p>
                )}

                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setViewing(r)} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50" data-view-cin>
                    <Eye size={14} /> Voir la CIN
                  </button>
                  {r.status === "PENDING" && (
                    <button type="button" disabled={busy} onClick={() => decide(r, "approve")} data-approve
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 text-white px-3 py-1.5 text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50">
                      {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Approuver
                    </button>
                  )}
                  {(r.status === "PENDING" || r.status === "APPROVED") && rejecting !== r.id && (
                    <button type="button" disabled={busy} onClick={() => setRejecting(r.id)} data-reject
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 text-red-700 px-3 py-1.5 text-sm font-semibold hover:bg-red-50 disabled:opacity-50">
                      <XCircle size={14} /> {r.status === "APPROVED" ? "Retirer l'approbation" : "Rejeter"}
                    </button>
                  )}
                  <button type="button" onClick={() => setHistoryOpen(historyOpen === r.id ? null : r.id)} aria-expanded={historyOpen === r.id} data-history-toggle
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">
                    Historique ({r.history?.length ?? 0})
                  </button>
                </div>

                {rejecting === r.id && (
                  <RejectForm row={r} busy={busy} onCancel={() => setRejecting(null)} onSubmit={(reason) => decide(r, "reject", reason)} />
                )}

                {historyOpen === r.id && (
                  <ol className="border-t border-gray-100 pt-2 space-y-1.5 text-xs text-gray-600" data-history>
                    {(r.history ?? []).map((h, i) => (
                      <li key={`${h.createdAt}-${i}`} className="flex flex-wrap gap-x-2 gap-y-0.5 min-w-0">
                        <span className="text-gray-400">{fmt(h.createdAt)}</span>
                        <span className="font-semibold">{ACTION_LABEL[h.action] ?? h.action}</span>
                        {h.submission != null && <span>· envoi n°{h.submission}</span>}
                        {h.from && h.to && <span>· {h.from} → {h.to}</span>}
                        {h.actor && <span className="break-all">· {h.actor}</span>}
                        {h.reason && <span className="basis-full break-words text-red-700">Motif : {h.reason}</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {viewing && <CinViewer row={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
