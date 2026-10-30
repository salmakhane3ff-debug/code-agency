"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, inputCls, btnPrimary, btnGhost } from "./ui";
import BrandSimStats from "@/components/brand/BrandSimStats";
import { brandT } from "@/lib/brandI18n";
import { displayBreakdown } from "@/lib/brandPricing";

const STATUS_UI = {
  PENDING_PAYMENT: { label: "En attente de paiement", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  ACTIVE:          { label: "Actif",                  cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  REJECTED:        { label: "Refusé",                 cls: "bg-red-50 text-red-700 border-red-200" },
  CANCELLED:       { label: "Annulé",                 cls: "bg-gray-100 text-gray-600 border-gray-200" },
  CLOSED:          { label: "Clôturé",                cls: "bg-slate-100 text-slate-700 border-slate-200" },
};
const PROOF_UI = { SUBMITTED: "reçue, à vérifier", ACCEPTED: "acceptée", REJECTED: "refusée", WITHDRAWN: "retirée (demande annulée)" };
// Actions needing a reason (visible to the participant, except the authorization reason).
const REASON_UI = {
  reject:    { help: "Indiquez le motif du refus (visible par l’affilié). La preuve est refusée définitivement.", placeholder: "Motif" },
  close:     { help: "Indiquez le motif de la clôture (visible par l’affilié). L’historique reste consultable en lecture seule.", placeholder: "Motif" },
  reopen:    { help: "Indiquez le motif de la réouverture. La simulation reprend à partir de maintenant, sans combler la période clôturée.", placeholder: "Motif" },
  authorize: { help: "Autorisez UNE nouvelle demande pour ce participant (usage unique). Indiquez le motif.", placeholder: "Motif" },
};
const fmt = (d) => (d ? new Date(d).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }) : "—");
const money = (n) => `${Number(n || 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} MAD`;
const t = brandT("fr");

function SimView({ id }) {
  const [windowKey, setWindowKey] = useState("24h");
  const [dash, setDash] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api(`/api/admin/brand/accesses/${encodeURIComponent(id)}/dashboard?window=${windowKey}`)
      .then((r) => (r.ok ? (setDash(r.data), setError(null)) : setError(r.error)));
  }, [id, windowKey]);
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!dash) return <Loader2 className="w-5 h-5 animate-spin text-gray-400" />;
  return (
    <div className="space-y-2">
      {!dash.started && <p className="text-xs text-gray-600">Démarrage prévu le {fmt(dash.simulationStartsAt)}.</p>}
      {dash.readOnly && <p className="text-xs text-gray-600">Accès clôturé le {fmt(dash.closedAt)} — historique en lecture seule.</p>}
      {dash.started && !dash.running && !dash.readOnly && <p className="text-xs text-gray-600">Simulation en pause.</p>}
      {dash.incomplete?.length > 0 && <p className="text-xs text-amber-700">Période incomplète (réglages non vérifiables) : {dash.incomplete.map((r) => `${fmt(r.from)} → ${fmt(r.to)}`).join(" ; ")}</p>}
      <BrandSimStats stats={dash.stats} windowKey={windowKey} onWindow={setWindowKey} t={t} />
    </div>
  );
}

function Authorizations({ affiliateId, refresh }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [reason, setReason] = useState("");
  const load = useCallback(async () => {
    const r = await api(`/api/admin/brand/authorizations?affiliateId=${encodeURIComponent(affiliateId)}`);
    if (r.ok) { setRows(r.data); setError(null); } else setError(r.error);
  }, [affiliateId]);
  useEffect(() => { load(); }, [load, refresh]);
  const revoke = async () => {
    const r = await api(`/api/admin/brand/authorizations/${encodeURIComponent(revoking)}/revoke`, { method: "POST", body: { reason } });
    if (r.ok) { setRevoking(null); setReason(""); load(); } else setError(r.error);
  };
  if (!rows?.length && !error) return null;
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 space-y-1.5">
      <p className="text-xs font-semibold text-gray-700">Autorisations de nouvelle demande</p>
      {(rows || []).map((x) => (
        <div key={x.id} className="flex flex-wrap items-center gap-2 text-[11px] text-gray-600">
          <span>{fmt(x.createdAt)} · {x.status === "UNUSED" ? "non utilisée" : x.status === "USED" ? `utilisée le ${fmt(x.consumedAt)}` : `révoquée le ${fmt(x.revokedAt)}`} · motif : {x.reason}</span>
          {x.status === "UNUSED" && revoking !== x.id && <button type="button" onClick={() => { setRevoking(x.id); setReason(""); }} className={btnGhost}>Révoquer</button>}
        </div>
      ))}
      {revoking && (
        <div className="flex flex-wrap gap-2">
          <input className={`${inputCls} sm:w-72`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motif de la révocation" />
          <button type="button" onClick={revoke} disabled={!reason.trim()} className={btnPrimary}>Confirmer</button>
          <button type="button" onClick={() => setRevoking(null)} className={btnGhost}>Annuler</button>
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

const INTEGRITY_LABELS = {
  amountMatchesSnapshot: "montant = total enregistré",
  breakdownRecomputes: "détail du prix recalculable",
  productsValid: "produits choisis valides",
  brandNameValid: "nom de marque valide",
  requestIdValid: "identifiant de demande valide",
  authorizationConsistent: "autorisation cohérente",
  noProof: "aucune preuve enregistrée",
  termsVersionExists: "version des conditions retrouvée",
  termsSnapshotShape: "copie des conditions lisible",
};

/** Consent verification state — information only, never an automatic action. */
function ConsentNotice({ a }) {
  if (!a.consent || a.consent === "VERIFIED") return null;
  const renewal = a.renewals?.length ? a.renewals[a.renewals.length - 1] : null;
  return (
    <div className="text-[11px] text-amber-700 space-y-0.5" data-consent-warning>
      {a.status === "ACTIVE" && <p>Consentement aux conditions non vérifiable — l’accès reste actif.</p>}
      {a.status === "PENDING_PAYMENT" && <p>Consentement aux conditions non vérifiable — paiement bloqué. Vous pouvez refuser la demande avec un motif.</p>}
      {a.status === "CLOSED" && <p>Consentement aux conditions non vérifiable — réouverture possible seulement après un nouveau consentement du participant aux conditions actuellement publiées.</p>}
      {a.status !== "ACTIVE" && a.status !== "PENDING_PAYMENT" && a.status !== "CLOSED" && <p>Consentement aux conditions non vérifiable.</p>}
      {renewal && (
        <p>
          Nouveau consentement (conditions v{renewal.termsVersion}) le {fmt(renewal.acceptedAt)}
          {renewal.context === "PENDING_RENEWAL" ? " — non utilisé pour le paiement." : "."}
        </p>
      )}
      {a.integrity && (
        <p className="text-gray-500">
          Vérifications (information seulement, n’autorisent pas le paiement) :{" "}
          {Object.entries(a.integrity.checks).map(([k, ok]) => `${INTEGRITY_LABELS[k] || k} ${ok ? "✓" : "✗"}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

function AccessRow({ a, onChanged }) {
  const [mode, setMode] = useState(null); // 'accept' | 'reject' | 'close' | 'reopen' | 'authorize' | 'sim'
  const [authRefresh, setAuthRefresh] = useState(0);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ui = STATUS_UI[a.status] || STATUS_UI.CANCELLED;

  const act = async () => {
    setBusy(true); setError(null);
    const r = mode === "authorize"
      ? await api("/api/admin/brand/authorizations", { method: "POST", body: { affiliateId: a.affiliateId, reason: value } })
      : await api(`/api/admin/brand/accesses/${encodeURIComponent(a.id)}`, { method: "POST", body: mode === "accept" ? { action: "accept-proof" } : { action: mode, reason: value } });
    setBusy(false);
    if (r.ok) { setMode(null); setValue(""); setAuthRefresh((n) => n + 1); onChanged(); } else setError(r.error);
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p dir="auto" className="text-sm font-bold text-gray-900">{a.brandName}</p>
          <p className="text-xs text-gray-500">@{a.affiliate?.username || a.affiliateId} · {a.package?.name} · {money(a.amount)} · conditions v{a.termsVersion}</p>
          <p className="text-[11px] text-gray-400">Demandé le {fmt(a.createdAt)}{a.activatedAt ? ` · activé le ${fmt(a.activatedAt)}` : ""}{a.closedAt ? ` · clôturé le ${fmt(a.closedAt)}` : ""}</p>
          {a.paymentReference && <p className="text-[11px] text-gray-500">Paiement vérifié : {a.paymentReference}</p>}
          {a.closeReason && <p className="text-[11px] text-gray-500">Motif : {a.closeReason}</p>}
          {a.lastReopenedAt && <p className="text-[11px] text-gray-500">Réouvert le {fmt(a.lastReopenedAt)}</p>}
          {a.paymentProof ? (
            <p className="text-[11px] text-gray-600">
              Preuve de paiement {PROOF_UI[a.paymentProof.status] || a.paymentProof.status} · {a.paymentProof.paymentMethod}
              {a.paymentProof.transferReference ? ` · réf. ${a.paymentProof.transferReference}` : ""} · envoyée le {fmt(a.paymentProof.submittedAt)}
              {a.paymentProof.reviewedAt ? ` · vérifiée le ${fmt(a.paymentProof.reviewedAt)}` : ""}{" · "}
              <a href={`/api/admin/brand/accesses/${encodeURIComponent(a.id)}/proof`} target="_blank" rel="noopener noreferrer" className="underline">voir le justificatif</a>
            </p>
          ) : a.status === "PENDING_PAYMENT" && <p className="text-[11px] text-gray-500">Aucune preuve de paiement reçue.</p>}
          {(a.referenceWarnings?.otherProofs?.length > 0 || a.referenceWarnings?.deposits?.length > 0) && (
            <p className="text-[11px] text-amber-700" data-reference-warning>
              Attention : la même référence de virement apparaît déjà sur {a.referenceWarnings.otherProofs.length} autre(s) preuve(s) de marque
              et {a.referenceWarnings.deposits.length} dépôt(s). Vérifiez avant d’accepter.
            </p>
          )}
          <ConsentNotice a={a} />
          {(() => {
            // A saved snapshot may lack fields: a missing figure shows "—" instead of breaking the list.
            const b = displayBreakdown(a.packageSnapshot?.breakdown);
            if (!b) return null;
            const m = (n) => (n === null ? "—" : money(n));
            return (
              <p className="text-[11px] text-gray-600" data-admin-breakdown>
                Montant demandé : prix {m(b.price)} + livraison {m(b.deliveryCost)} + logistique {m(b.logisticsCost)} = {m(b.subtotal)} HT ;
                TVA {b.vat.percent ?? "—"} % = {m(b.vat.amount)} ; total {m(b.total)}
              </p>
            );
          })()}
          {a.products?.length > 0 && (
            <p dir="auto" className="text-[11px] text-gray-600">Produits choisis : {a.products.map((p) => p.title).join(" · ")}</p>
          )}
        </div>
        <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${ui.cls}`}>{ui.label}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {a.status === "PENDING_PAYMENT" && <>
          {a.paymentProof?.status === "SUBMITTED" && !a.paymentBlockedReason && (
            <button type="button" onClick={() => { setMode("accept"); setValue(""); }} className={btnPrimary}>Accepter la preuve — activer</button>
          )}
          <button type="button" onClick={() => { setMode("reject"); setValue(""); }} className={btnGhost}>Refuser</button>
        </>}
        {(a.status === "ACTIVE" || a.status === "CLOSED") && (
          <button type="button" onClick={() => setMode(mode === "sim" ? null : "sim")} className={btnGhost}>{mode === "sim" ? "Masquer" : "Voir les données simulées"}</button>
        )}
        {a.status === "ACTIVE" && <button type="button" onClick={() => { setMode("close"); setValue(""); }} className={btnGhost}>Clôturer</button>}
        {a.status === "CLOSED" && <>
          <button type="button" onClick={() => { setMode("reopen"); setValue(""); }} className={btnGhost}>Réouvrir</button>
          <button type="button" onClick={() => { setMode("authorize"); setValue(""); }} className={btnGhost}>Autoriser une nouvelle demande</button>
        </>}
      </div>

      {mode === "accept" && (
        <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 space-y-2">
          <p className="text-xs text-gray-600">Acceptez uniquement après avoir vérifié le justificatif et la réception du virement. L’accès est activé immédiatement.</p>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={act} disabled={busy} className={btnPrimary}>{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Confirmer</button>
            <button type="button" onClick={() => setMode(null)} className={btnGhost}>Annuler</button>
          </div>
        </div>
      )}
      {REASON_UI[mode] && (
        <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 space-y-2">
          <p className="text-xs text-gray-600">{REASON_UI[mode].help}</p>
          <input className={inputCls} value={value} onChange={(e) => setValue(e.target.value)} placeholder={REASON_UI[mode].placeholder} />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={act} disabled={busy || !value.trim()} className={btnPrimary}>{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Confirmer</button>
            <button type="button" onClick={() => setMode(null)} className={btnGhost}>Annuler</button>
          </div>
        </div>
      )}
      {mode === "sim" && <SimView id={a.id} />}
      {a.status === "CLOSED" && <Authorizations affiliateId={a.affiliateId} refresh={authRefresh} />}
    </div>
  );
}

export default function AccessesTab() {
  const [status, setStatus] = useState("PENDING_PAYMENT");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const r = await api(`/api/admin/brand/accesses?status=${status}&q=${encodeURIComponent(q)}`);
    if (r.ok) { setRows(r.data); setError(null); } else setError(r.error);
  }, [status, q]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select className={`${inputCls} sm:w-56`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="ALL">Tous les statuts</option>
          {Object.entries(STATUS_UI).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <input className={`${inputCls} sm:w-72`} placeholder="Rechercher (marque ou identifiant)…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {rows === null ? <Loader2 className="w-6 h-6 animate-spin text-gray-400" /> : rows.length === 0
        ? <p className="text-sm text-gray-500 bg-white rounded-2xl border border-gray-100 p-6 text-center">Aucune demande.</p>
        : rows.map((a) => <AccessRow key={a.id} a={a} onChanged={load} />)}
    </div>
  );
}
