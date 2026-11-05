"use client";
/**
 * /admin/activation-recovery — admin review of affiliate ACTIVATION RECOVERY requests
 * (Affiliate Recruiter System, Phase 6 part 1). French admin UI.
 *
 *   • GET  /api/admin/activation-recovery?status=   → requests (never a code)
 *   • GET  /api/admin/activation-recovery/<id>      → request + affiliate + recruiter + code
 *                                                     states + audit trail (never a code)
 *   • POST /api/admin/activation-recovery/<id>      { action: 'approve' | 'reject', note? }
 *       approve → { activation: { code, expiresAt } } — shown ONCE here, never stored,
 *       cleared when the panel closes. The admin hands it to the affiliate directly.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Loader2, RefreshCw, X } from "lucide-react";

const API = "/api/admin/activation-recovery";
const GENERIC_ERROR = "Une erreur est survenue. Veuillez réessayer.";
const UNAUTHORIZED_TEXT = "Session expirée ou accès refusé. Reconnectez-vous.";

const DATE_FMT = new Intl.DateTimeFormat("fr-FR", { timeZone: "Africa/Casablanca", dateStyle: "short", timeStyle: "short" });
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? DATE_FMT.format(d) : "—";
};

const FILTERS = [
  { key: "PENDING", label: "En attente" },
  { key: "APPROVED", label: "Approuvées" },
  { key: "REJECTED", label: "Rejetées" },
  { key: "ALL", label: "Toutes" },
];
const STATUS = {
  PENDING: { label: "En attente", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  APPROVED: { label: "Approuvée", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  REJECTED: { label: "Rejetée", cls: "bg-red-50 text-red-700 border-red-200" },
};
const IDENTITY = { APPROVED: "Approuvée", PENDING: "En attente", REJECTED: "Refusée", NONE: "Non envoyée" };
const CODE_STATE = {
  ACTIVE: { label: "Actif", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  USED: { label: "Utilisé", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  EXPIRED: { label: "Expiré", cls: "bg-gray-100 text-gray-600 border-gray-200" },
  INVALIDATED: { label: "Invalidé", cls: "bg-red-50 text-red-700 border-red-200" },
};
const INVALID_REASON = {
  REGENERATED: "Régénéré",
  TOO_MANY_ATTEMPTS: "Trop de tentatives",
  CREDENTIALS_CHANGED: "Identifiants modifiés",
  ADMIN_RECOVERY: "Récupération admin",
};
const ISSUED_BY = { RECRUITER: "Recruteur", ADMIN: "Admin" };
const AUDIT_ACTION = {
  AFFILIATE_CREATED: "Affilié créé par le recruteur",
  AFFILIATE_ACTIVATION_CODE_ISSUED: "Nouveau code émis (recruteur)",
  AFFILIATE_CREDENTIALS_SET: "Mot de passe choisi (code utilisé)",
  ACTIVATION_RECOVERY_REQUESTED: "Demande de récupération",
  ACTIVATION_RECOVERY_APPROVED: "Récupération approuvée",
  ACTIVATION_RECOVERY_REJECTED: "Récupération rejetée",
  RECRUIT_REWARD_EARNED: "Récompense recruteur",
};

function actorText(a) {
  if (a?.actorType === "RECRUITER") return "Recruteur";
  if (a?.actorType === "ADMIN") return `Admin${a.actorId ? ` (${a.actorId})` : ""}`;
  if (a?.actorType === "SYSTEM") return a.actorId === "PUBLIC_FORM" ? "Formulaire public" : "Système";
  return a?.actorType || "—";
}

async function readBody(res) {
  return res.json().catch(() => null);
}
function errorText(res, body) {
  if (res.status === 401 || res.status === 403) return UNAUTHORIZED_TEXT;
  return typeof body?.error === "string" && body.error ? body.error : GENERIC_ERROR;
}

async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fallback below */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function StatusBadge({ status }) {
  const s = STATUS[status] ?? { label: status || "—", cls: "bg-gray-100 text-gray-600 border-gray-200" };
  return <span className={`shrink-0 text-[11px] font-bold rounded-full px-2 py-0.5 border ${s.cls}`} data-recovery-status={status}>{s.label}</span>;
}
function ActiveBadge({ active }) {
  return (
    <span className={`shrink-0 text-[11px] font-bold rounded-full px-2 py-0.5 border ${active ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-gray-100 text-gray-600 border-gray-200"}`}>
      {active ? "Actif" : "Inactif"}
    </span>
  );
}

/** The new code, shown ONCE (state only: cleared when the panel closes). */
function NewCodeCard({ activation }) {
  const [copied, setCopied] = useState("");
  const link = typeof window !== "undefined" ? `${window.location.origin}/affiliate/activate#code=${activation.code}` : "";
  const doCopy = async (what, text) => {
    const ok = await copyText(text);
    setCopied(ok ? what : "error");
    setTimeout(() => setCopied(""), 2500);
  };
  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 space-y-3 min-w-0" data-new-code-card>
      <p className="text-sm font-bold text-emerald-800">Nouveau code d&apos;activation</p>
      <div className="rounded-xl bg-white border border-emerald-200 px-3 py-2 font-mono text-sm break-all select-all" dir="ltr" data-recovery-code>
        {activation.code}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => doCopy("code", activation.code)} data-copy-code
          className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100">
          {copied === "code" ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
          Copier le code
        </button>
        <button type="button" onClick={() => doCopy("link", link)} data-copy-link
          className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100">
          {copied === "link" ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
          Copier le lien d&apos;activation
        </button>
      </div>
      {copied === "error" && <p className="text-xs text-red-600">Copie impossible : sélectionnez le code manuellement.</p>}
      <p className="text-xs text-emerald-800 break-all" dir="ltr" data-recovery-link-text>{link}</p>
      <p className="text-xs text-emerald-800">Valable jusqu&apos;au {fmtDate(activation.expiresAt)} (24 h, usage unique).</p>
      <p className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2" data-new-code-warning>
        Transmettez ce code uniquement à l&apos;affilié, directement (ne passez pas par son recruteur). Il ne sera plus jamais affiché.
      </p>
    </div>
  );
}

function DetailPanel({ id, onClose, onReviewed }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState(null); // 'approve' | 'reject' | null
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [activation, setActivation] = useState(null);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch(`${API}/${encodeURIComponent(id)}`, { credentials: "include", cache: "no-store" });
      const body = await readBody(res);
      if (res.ok && body?.request) setData(body);
      else setLoadError(errorText(res, body));
    } catch {
      setLoadError(GENERIC_ERROR);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // The code lives only in this component's state: closing the panel discards it.
  const close = () => { if (busy) return; setActivation(null); onClose(); };

  async function submit() {
    if (busy || !mode) return;
    setBusy(true); setActionError("");
    try {
      const res = await fetch(`${API}/${encodeURIComponent(id)}`, {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const body = await readBody(res);
      if (res.ok) {
        if (mode === "approve" && typeof body?.activation?.code === "string") setActivation(body.activation);
        setMode(null); setNote("");
        onReviewed();
        await load();
      } else {
        setActionError(errorText(res, body));
      }
    } catch {
      setActionError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  const r = data?.request;
  const a = data?.affiliate;

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="ar-detail-title" data-recovery-detail>
      <button type="button" className="fixed inset-0 bg-gray-900/40" aria-label="Fermer" onClick={close} />
      <div className="relative w-full max-w-3xl bg-white rounded-2xl shadow-xl p-5 space-y-5 min-w-0 my-auto">
        <div className="flex items-start justify-between gap-3 min-w-0">
          <h3 id="ar-detail-title" className="text-base font-bold text-gray-900 break-words min-w-0">Demande de récupération</h3>
          <button type="button" onClick={close} disabled={busy} aria-label="Fermer" className="shrink-0 p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-50" data-close-detail>
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {loadError && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{loadError}</p>}
        {!data && !loadError && <p className="text-sm text-gray-500">Chargement…</p>}

        {activation && <NewCodeCard activation={activation} />}

        {r && (
          <>
            <section className="space-y-2 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={r.status} />
                <span className="text-xs text-gray-500">Reçue le {fmtDate(r.requestedAt)}</span>
              </div>
              <p className="text-sm text-gray-800 whitespace-pre-wrap break-words bg-gray-50 border border-gray-100 rounded-xl px-3 py-2" data-recovery-message-full>{r.message}</p>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs min-w-0">
                <div className="flex gap-1 min-w-0"><dt className="text-gray-500 shrink-0">Téléphone de contact :</dt><dd className="text-gray-800 truncate" dir="ltr">{r.contactPhone || "—"}</dd></div>
                <div className="flex gap-1 min-w-0"><dt className="text-gray-500 shrink-0">IP déclarée :</dt><dd className="text-gray-800 truncate" dir="ltr">{r.requestIp || "—"}</dd></div>
                {r.status !== "PENDING" && (
                  <>
                    <div className="flex gap-1 min-w-0"><dt className="text-gray-500 shrink-0">Traitée par :</dt><dd className="text-gray-800 truncate">{r.reviewedBy || "—"}</dd></div>
                    <div className="flex gap-1 min-w-0"><dt className="text-gray-500 shrink-0">Le :</dt><dd className="text-gray-800 truncate">{fmtDate(r.reviewedAt)}</dd></div>
                    <div className="flex gap-1 min-w-0 sm:col-span-2"><dt className="text-gray-500 shrink-0">Note :</dt><dd className="text-gray-800 break-words min-w-0">{r.reviewNote || "—"}</dd></div>
                  </>
                )}
              </dl>
            </section>

            <section className="grid grid-cols-1 sm:grid-cols-2 gap-3 min-w-0">
              <div className="rounded-xl border border-gray-200 p-3 min-w-0 space-y-1">
                <p className="text-xs font-bold text-gray-700">Affilié</p>
                {a ? (
                  <>
                    <div className="flex items-center gap-2 min-w-0"><p className="text-sm font-semibold text-gray-900 truncate">{a.name || "—"}</p><ActiveBadge active={a.isActive} /></div>
                    <p className="text-xs text-gray-500 truncate" dir="ltr">@{a.username}{a.phone ? ` · ${a.phone}` : ""}</p>
                    <p className="text-xs text-gray-500">Créé le {fmtDate(a.createdAt)}</p>
                    <p className="text-xs text-gray-500" data-identity-status={data.identityStatus}>Identité : {IDENTITY[data.identityStatus] ?? data.identityStatus}</p>
                  </>
                ) : <p className="text-xs text-gray-500">Introuvable.</p>}
              </div>
              <div className="rounded-xl border border-gray-200 p-3 min-w-0 space-y-1">
                <p className="text-xs font-bold text-gray-700">Recruteur</p>
                {data.recruiter ? (
                  <>
                    <p className="text-sm font-semibold text-gray-900 truncate">{data.recruiter.name || "—"}</p>
                    <p className="text-xs text-gray-500 truncate" dir="ltr">@{data.recruiter.username}</p>
                    <p className="text-xs text-gray-500">Lien créé le {fmtDate(data.recruiter.linkedAt)}</p>
                  </>
                ) : <p className="text-xs text-gray-500">Aucun recruteur lié.</p>}
              </div>
            </section>

            <section className="space-y-2 min-w-0">
              <h4 className="text-sm font-bold text-gray-900">Historique des codes d&apos;activation</h4>
              {(data.codes ?? []).length === 0 ? <p className="text-xs text-gray-500">Aucun code.</p> : (
                <div className="overflow-x-auto rounded-xl border border-gray-200">
                  <table className="min-w-full text-xs">
                    <thead className="bg-gray-50 text-gray-500">
                      <tr>
                        <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Émis le</th>
                        <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Émis par</th>
                        <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">État</th>
                        <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Expire le</th>
                        <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Utilisé le</th>
                        <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Tentatives échouées</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.codes.map((c) => {
                        const st = CODE_STATE[c.state] ?? { label: c.state, cls: "bg-gray-100 text-gray-600 border-gray-200" };
                        return (
                          <tr key={c.id} className="border-t border-gray-100" data-code-history-row={c.state}>
                            <td className="px-3 py-2 whitespace-nowrap">{fmtDate(c.createdAt)}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{ISSUED_BY[c.createdByType] ?? c.createdByType}</td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              <span className={`text-[11px] font-bold rounded-full px-2 py-0.5 border ${st.cls}`}>{st.label}</span>
                              {c.state === "INVALIDATED" && c.invalidatedReason && <span className="ml-1 text-gray-500">({INVALID_REASON[c.invalidatedReason] ?? c.invalidatedReason})</span>}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">{fmtDate(c.expiresAt)}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{fmtDate(c.usedAt)}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{c.failedAttempts ?? 0}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {(data.otherRequests ?? []).length > 0 && (
              <section className="space-y-2 min-w-0">
                <h4 className="text-sm font-bold text-gray-900">Autres demandes de cet affilié</h4>
                <ul className="space-y-1 text-xs">
                  {data.otherRequests.map((o) => (
                    <li key={o.id} className="flex flex-wrap items-center gap-2" data-other-request>
                      <StatusBadge status={o.status} />
                      <span className="text-gray-600">le {fmtDate(o.requestedAt)}</span>
                      {o.reviewedAt && <span className="text-gray-500">— traitée le {fmtDate(o.reviewedAt)}{o.reviewedBy ? ` par ${o.reviewedBy}` : ""}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="space-y-2 min-w-0">
              <h4 className="text-sm font-bold text-gray-900">Historique (audit)</h4>
              {(data.audit ?? []).length === 0 ? <p className="text-xs text-gray-500">Aucune entrée.</p> : (
                <div className="overflow-x-auto rounded-xl border border-gray-200">
                  <table className="min-w-full text-xs">
                    <thead className="bg-gray-50 text-gray-500">
                      <tr>
                        <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Date</th>
                        <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Action</th>
                        <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Acteur</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.audit.map((e, i) => (
                        <tr key={`${e.action}-${e.createdAt}-${i}`} className="border-t border-gray-100" data-audit-row={e.action}>
                          <td className="px-3 py-2 whitespace-nowrap">{fmtDate(e.createdAt)}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{AUDIT_ACTION[e.action] ?? e.action}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{actorText(e)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {r.status === "PENDING" && !activation && (
              <section className="space-y-3 min-w-0 border-t border-gray-100 pt-4">
                {!mode && (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => { setMode("approve"); setActionError(""); }} disabled={busy} data-approve
                      className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
                      <KeyRound className="w-4 h-4" aria-hidden="true" /> Approuver
                    </button>
                    <button type="button" onClick={() => { setMode("reject"); setActionError(""); }} disabled={busy} data-reject
                      className="rounded-xl border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60">
                      Rejeter
                    </button>
                  </div>
                )}
                {mode && (
                  <div className="space-y-3 rounded-xl border border-gray-200 p-3 min-w-0" data-review-confirm={mode}>
                    {mode === "approve" ? (
                      <p className="text-sm text-gray-700">
                        L&apos;approbation <strong>invalide le mot de passe actuel et tous les codes en cours</strong> de cet affilié, puis génère un nouveau code
                        affiché une seule fois. Transmettez-le <strong>uniquement à l&apos;affilié, directement</strong>. Vérifiez d&apos;abord son identité
                        (par exemple en l&apos;appelant). Le compte restera inactif jusqu&apos;à sa validation habituelle.
                      </p>
                    ) : (
                      <p className="text-sm text-gray-700">La demande sera fermée sans aucun autre changement.</p>
                    )}
                    <div>
                      <label htmlFor="ar-note" className="block text-xs font-semibold text-gray-700 mb-1">Note (optionnelle)</label>
                      <textarea id="ar-note" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)}
                        className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-500" data-review-note />
                    </div>
                    {actionError && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2" data-review-error>{actionError}</p>}
                    <div className="flex flex-wrap justify-end gap-2">
                      <button type="button" onClick={() => { setMode(null); setActionError(""); }} disabled={busy}
                        className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-semibold disabled:opacity-60">Annuler</button>
                      <button type="button" onClick={submit} disabled={busy} data-confirm-review
                        className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 ${mode === "approve" ? "bg-emerald-600" : "bg-red-600"}`}>
                        {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                        {mode === "approve" ? "Confirmer l'approbation" : "Confirmer le rejet"}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RecoveryRow({ r, onOpen }) {
  const a = r.affiliate;
  const excerpt = typeof r.message === "string" && r.message.length > 120 ? `${r.message.slice(0, 120)}…` : r.message;
  return (
    <li className="bg-white rounded-2xl border border-gray-200 p-4 min-w-0" data-recovery-row={r.id}>
      <div className="flex items-start justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <p className="font-semibold text-gray-900 truncate">{a?.name || "Affilié introuvable"}</p>
            <StatusBadge status={r.status} />
            {a && <ActiveBadge active={a.isActive} />}
          </div>
          {a && <p className="text-xs text-gray-500 truncate" dir="ltr">@{a.username}{a.phone ? ` · ${a.phone}` : ""}</p>}
          <p className="text-xs text-gray-500 truncate">Recruteur : {r.recruiterUsername ? <span dir="ltr">@{r.recruiterUsername}</span> : "—"}</p>
        </div>
        <button type="button" onClick={() => onOpen(r.id)} data-open-recovery
          className="shrink-0 rounded-xl border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50">
          Examiner
        </button>
      </div>
      <p className="mt-2 text-sm text-gray-700 break-words">{excerpt}</p>
      <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs min-w-0">
        <div className="flex gap-1 min-w-0"><dt className="text-gray-500 shrink-0">Reçue le :</dt><dd className="text-gray-800 truncate">{fmtDate(r.requestedAt)}</dd></div>
        <div className="flex gap-1 min-w-0"><dt className="text-gray-500 shrink-0">Contact :</dt><dd className="text-gray-800 truncate" dir="ltr">{r.contactPhone || "—"}</dd></div>
        {r.status !== "PENDING" && (
          <div className="flex gap-1 min-w-0 sm:col-span-2"><dt className="text-gray-500 shrink-0">Traitée :</dt><dd className="text-gray-800 truncate">{r.reviewedBy || "—"} — {fmtDate(r.reviewedAt)}</dd></div>
        )}
      </dl>
    </li>
  );
}

export default function AdminActivationRecoveryPage() {
  const [filter, setFilter] = useState("PENDING");
  const [list, setList] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError("");
    try {
      const qs = filter === "ALL" ? "" : `?status=${filter}`;
      const res = await fetch(`${API}${qs}`, { credentials: "include", cache: "no-store" });
      const body = await readBody(res);
      if (res.ok) setList(Array.isArray(body?.recoveries) ? body.recoveries : []);
      else setLoadError(errorText(res, body));
    } catch {
      setLoadError(GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { setList(null); load(); }, [load]);

  const pendingCount = (list ?? []).filter((r) => r.status === "PENDING").length;

  return (
    <div className="py-6 max-w-4xl space-y-5 min-w-0 [contain:inline-size]" data-admin-activation-recovery>
      <div className="flex items-start justify-between gap-3 min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <KeyRound className="w-6 h-6 text-gray-700 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">🔑 Récupération d&apos;activation</h1>
            <p className="text-sm text-gray-500">Affiliés dont le code d&apos;activation a été utilisé avant eux. Vérifiez l&apos;identité avant d&apos;approuver.</p>
          </div>
        </div>
        <button type="button" onClick={load} disabled={loading} aria-label="Actualiser"
          className="shrink-0 p-2 rounded-xl border border-gray-200 bg-white text-gray-600 hover:border-gray-400 disabled:opacity-60">
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
        </button>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrer par statut">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)} aria-pressed={filter === f.key} data-status-filter={f.key}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold border ${filter === f.key ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-700 border-gray-300 hover:border-gray-500"}`}>
            {f.label}
          </button>
        ))}
      </div>

      <section aria-labelledby="ar-list-title" className="space-y-3 min-w-0">
        <h2 id="ar-list-title" className="text-sm font-bold text-gray-900">
          Demandes{list ? ` (${list.length}${filter === "ALL" ? ` — ${pendingCount} en attente` : ""})` : ""}
        </h2>
        {loadError && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2" data-load-error>{loadError}</p>}
        {!list && !loadError && <p className="text-sm text-gray-500">Chargement…</p>}
        {list && list.length === 0 && <p className="text-sm text-gray-500" data-empty>Aucune demande.</p>}
        {list && list.length > 0 && (
          <ul className="space-y-2 min-w-0">
            {list.map((r) => <RecoveryRow key={r.id} r={r} onOpen={setOpenId} />)}
          </ul>
        )}
      </section>

      {openId && <DetailPanel id={openId} onClose={() => setOpenId(null)} onReviewed={load} />}
    </div>
  );
}
