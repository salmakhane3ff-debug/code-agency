"use client";
// Building blocks shared by the demo member / brand editors (SIMULATION ONLY).

import { useRef, useState } from "react";
import { X, Upload, Loader2, Archive, ArchiveRestore } from "lucide-react";
import {
  dcApi, checkImageFile, CODE_TEXT, btnGhost, btnDanger, btnPrimary, inputCls, Field, previewPerOrder, fmtDh, fmtPct, fmtDateTime, Avatar,
} from "./ui";

/** Right-side drawer (full screen on mobile). */
export function Drawer({ title, onClose, children, busy }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => (busy ? null : onClose())}>
      <div className="w-full max-w-2xl h-full bg-gray-50 overflow-y-auto shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-3 bg-white border-b border-gray-100">
          <h2 className="text-base font-bold text-gray-900 truncate">{title}</h2>
          <button type="button" onClick={onClose} disabled={busy} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" aria-label="Fermer">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-4">{children}</div>
      </div>
    </div>
  );
}

export function Section({ title, children, right }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-gray-900">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Image upload (multipart field "file") with client-side JPEG/PNG/WebP ≤ 5 MB check and preview. */
export function ImageUploader({ path, currentUrl, name, round, resultKey, onUploaded }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const bad = checkImageFile(file);
    if (bad) { setError(CODE_TEXT[bad]); return; }
    setError(null);
    const local = URL.createObjectURL(file);
    setPreview(local);
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    const r = await dcApi(path, { method: "POST", form });
    setBusy(false);
    URL.revokeObjectURL(local);
    setPreview(null);
    if (r.ok) onUploaded(r.data?.[resultKey] || null);
    else setError(r.error);
  };

  return (
    <div className="flex items-center gap-4">
      <div className="relative">
        <Avatar src={preview || currentUrl} name={name} size={72} round={round} />
        {busy && <span className="absolute inset-0 flex items-center justify-center rounded-full bg-white/60"><Loader2 className="w-5 h-5 animate-spin text-blue-600" /></span>}
      </div>
      <div className="space-y-1">
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={pick} />
        <button type="button" className={btnGhost} disabled={busy} onClick={() => inputRef.current?.click()}>
          <Upload className="w-3.5 h-3.5" /> {currentUrl ? "Remplacer l'image" : "Téléverser une image"}
        </button>
        <p className="text-[11px] text-gray-400">JPEG, PNG ou WebP · 5 Mo maximum</p>
        {error && <p className="text-[11px] text-red-600">{error}</p>}
      </div>
    </div>
  );
}

/** Min / max daily orders + price (DH) + allocation (%) with the live "1 demo order = X DH" preview. */
export function RateFields({ form, set, errors, keys, allocationLabel, remainderLabel }) {
  const p = previewPerOrder(form[keys.price], form[keys.pct]);
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Min. commandes démo / jour" error={errors[keys.min]}>
        <input className={inputCls} inputMode="numeric" value={form[keys.min]} onChange={(e) => set(keys.min, e.target.value)} />
      </Field>
      <Field label="Max. commandes démo / jour" error={errors[keys.max]}>
        <input className={inputCls} inputMode="numeric" value={form[keys.max]} onChange={(e) => set(keys.max, e.target.value)} />
      </Field>
      <Field label="Prix de vente simulé (DH)" error={errors[keys.priceErr]}>
        <input className={inputCls} inputMode="decimal" value={form[keys.price]} onChange={(e) => set(keys.price, e.target.value)} />
      </Field>
      <Field label={allocationLabel} error={errors[keys.pctErr]}>
        <input className={inputCls} inputMode="decimal" value={form[keys.pct]} onChange={(e) => set(keys.pct, e.target.value)} />
      </Field>
      <div className="col-span-2 rounded-xl bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-blue-900">
        {p
          ? <>1 commande démo = <strong>{fmtDh(p.earningsCents)}</strong> ({fmtPct(p.bps)} de {fmtDh(p.priceCents)})
            {remainderLabel && <span className="block text-blue-800/80 mt-0.5">Reste {fmtDh(p.remainderCents)} : {remainderLabel}</span>}</>
          : "Aperçu : saisissez un prix et un pourcentage valides."}
      </div>
    </div>
  );
}

/**
 * Archive block (permanent delete no longer exists). Archiving disables the profile: no more demo events, gone from the
 * public rankings; its demo history is kept and stays visible here. Enabled only when `blockers` is empty.
 */
export function ArchiveZone({ blockers, onArchive, busy, label }) {
  const can = blockers.length === 0;
  return (
    <Section title="Archivage">
      <p className="text-xs text-gray-500 leading-relaxed">
        Archiver désactive ce profil démo : il ne génère plus d&apos;événements démo et disparaît des classements publics.
        Son historique démo est <strong>conservé</strong> et reste visible dans l&apos;admin. Vous pourrez le restaurer
        plus tard (il reviendra désactivé).
      </p>
      {!can && <ul className="text-xs text-amber-800 list-disc ps-4 space-y-0.5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      <button type="button" className={btnDanger} disabled={!can || busy} onClick={onArchive}>
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />} {label}
      </button>
    </Section>
  );
}

/** Banner of an archived profile (read-only editor) with the Restore action; `blockers` explain why restoring is not possible yet. */
export function ArchivedBanner({ archivedAt, blockers = [], onRestore, busy, label }) {
  const can = blockers.length === 0;
  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-2 text-amber-900" data-archived-banner>
      <p className="text-sm font-bold">Profil archivé le {fmtDateTime(archivedAt)} — lecture seule</p>
      <p className="text-xs leading-relaxed">
        Il ne génère plus d&apos;événements démo et n&apos;apparaît plus dans les classements publics. Son historique démo est conservé.
        Restaurez-le pour le modifier : il reviendra <strong>désactivé</strong>, à réactiver ensuite dans cet éditeur.
      </p>
      {!can && <ul className="text-xs list-disc ps-4 space-y-0.5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      <button type="button" className={btnPrimary} disabled={!can || busy} onClick={onRestore}>
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArchiveRestore className="w-3.5 h-3.5" />} {label}
      </button>
    </section>
  );
}
