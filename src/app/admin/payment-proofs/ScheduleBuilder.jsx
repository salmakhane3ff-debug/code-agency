"use client";

/**
 * Manual bulk builder for payment proofs, in one of two publication modes chosen by the admin:
 *   • "Programmer la publication": each proof is published at its Casablanca time (steps below);
 *   • "Publier maintenant": no date / time; after an explicit confirmation each proof is created and
 *     published at once by the server (same publication pipeline as the scheduled ones).
 *   1. edit   — the admin picks a period (start date + number of days) and adds
 *               proofs one by one in each day: the count per day and the exact time
 *               of every proof are fully manual (nothing is distributed automatically)
 *   2. review — the server validates the WHOLE schedule (nothing is written); every
 *               error is shown per row; confirmation is blocked while anything is wrong
 *   3. submit — proofs are created ONE BY ONE (multipart, idempotent per clientRef);
 *               per-row status; only failed rows are retried, with the SAME clientRef
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Copy, Trash2, CheckCircle2, AlertTriangle, Loader2, ImageIcon, CalendarDays, ArrowLeft, RotateCcw, Clock, Send } from "lucide-react";
import {
  inputCls, btnPrimary, btnGhost, btnDanger, api, apiErrorText, uuid, casablancaToday, addDays, dayLabel, fmtMad,
  errText, fileProblem, ACCEPTED_TYPES, Declarations, scheduleProblem, Modal, FAILURE_TEXT, fmtInstant, durationInForceText,
} from "./ui";

const newRow = (date) => ({
  clientRef: uuid(), date, displayName: "", amount: "", time: "", file: null, preview: null, privacy: false, authenticity: false,
});

const STATE_TEXT = {
  pending: "En attente", sending: "Envoi…", done: "Programmée", existing: "Déjà créée", failed: "Échec",
  published: "Publiée", pubfailed: "Échec de publication",
};
// Rows that are final (never resent): created / published, or created but marked FAILED by the publication.
const FINAL_STATES = ["done", "existing", "published", "pubfailed"];

/** The two publication modes (labels shown to the admin). */
export const PUBLISH_MODES = [
  { id: "schedule", label: "Programmer la publication", hint: "Publication automatique à la date et à l’heure choisies (heure du Maroc).", Icon: Clock },
  { id: "now", label: "Publier maintenant", hint: "Publication immédiate après votre confirmation, sans date ni heure.", Icon: Send },
];

function RowEditor({ row, onChange, onRemove, onDuplicate, disabled, showTime = true }) {
  const pick = (e) => {
    const f = e.target.files?.[0] || null;
    if (row.preview) URL.revokeObjectURL(row.preview);
    onChange({ file: f, preview: f ? URL.createObjectURL(f) : null });
  };
  const problem = row.file ? fileProblem(row.file) : null;
  const timeProblem = disabled || !showTime ? null : scheduleProblem(row.date, row.time); // same rule as the server
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 space-y-2.5 min-w-0">
      <div className={`grid grid-cols-1 ${showTime ? "sm:grid-cols-[1fr_120px_110px]" : "sm:grid-cols-[1fr_120px]"} gap-2 min-w-0`}>
        <label className="block min-w-0">
          <span className="text-[11px] font-semibold text-gray-600">Nom affiché</span>
          <input className={inputCls} value={row.displayName} maxLength={40} disabled={disabled} placeholder="ex. Amina K."
            onChange={(e) => onChange({ displayName: e.target.value })} />
        </label>
        <label className="block min-w-0">
          <span className="text-[11px] font-semibold text-gray-600">Montant (MAD)</span>
          <input className={inputCls} value={row.amount} inputMode="decimal" disabled={disabled} placeholder="1500"
            onChange={(e) => onChange({ amount: e.target.value })} />
        </label>
        {showTime && (
          <label className="block min-w-0">
            <span className="text-[11px] font-semibold text-gray-600">Heure (heure du Maroc)</span>
            <input type="time" className={inputCls} value={row.time} disabled={disabled} onChange={(e) => onChange({ time: e.target.value })} />
            {timeProblem && <span className="block text-[11px] text-red-600" data-schedule-problem={timeProblem}>{errText(timeProblem)}</span>}
          </label>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 min-w-0">
        <div className="w-16 h-16 rounded-lg border border-gray-200 bg-gray-50 overflow-hidden flex items-center justify-center shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {row.preview ? <img src={row.preview} alt="" className="w-full h-full object-cover" /> : <ImageIcon className="w-5 h-5 text-gray-300" aria-hidden="true" />}
        </div>
        <label className="min-w-0 flex-1">
          <span className="text-[11px] font-semibold text-gray-600">Reçu (JPEG, PNG ou WebP, 8 Mo max.)</span>
          <input type="file" accept={ACCEPTED_TYPES.join(",")} disabled={disabled} onChange={pick}
            className="block w-full min-w-0 text-xs text-gray-600 file:mr-2 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-xs" />
          {row.file && <span className="block text-[11px] text-gray-500 truncate">{row.file.name}</span>}
          {problem && <span className="block text-[11px] text-red-600">{problem}</span>}
        </label>
      </div>
      <Declarations idPrefix={row.clientRef} privacy={row.privacy} authenticity={row.authenticity} onChange={onChange} />
      {disabled && <p className="text-[11px] font-semibold text-emerald-700">Déjà programmée — cette preuve ne sera pas renvoyée.</p>}
      <div className="flex flex-wrap gap-2 justify-end">
        <button type="button" className={btnGhost} onClick={onDuplicate} disabled={disabled}><Copy className="w-3.5 h-3.5" />Dupliquer</button>
        <button type="button" className={btnDanger} onClick={onRemove} disabled={disabled}><Trash2 className="w-3.5 h-3.5" />Retirer</button>
      </div>
    </div>
  );
}

export default function ScheduleBuilder({ onShowList, displaySettings = null }) {
  // The display duration is the global setting IN FORCE when each proof is actually published (never hard-coded here).
  const duration = durationInForceText(displaySettings);
  const [mode, setMode] = useState("schedule"); // schedule | now — the publication mode of this batch
  const [confirmNow, setConfirmNow] = useState(false);
  const [startDate, setStartDate] = useState(() => casablancaToday());
  const [dayCount, setDayCount] = useState(7);
  const [rows, setRows] = useState([]);
  const [batchId, setBatchId] = useState(() => uuid());
  const [phase, setPhase] = useState("edit"); // edit | review | submit
  const [review, setReview] = useState(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState(null);
  const [status, setStatus] = useState({}); // clientRef → { state, message }
  const [sending, setSending] = useState(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const days = useMemo(() => {
    const n = Math.min(31, Math.max(1, Number(dayCount) || 1));
    return /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? Array.from({ length: n }, (_, i) => addDays(startDate, i)) : [];
  }, [startDate, dayCount]);
  const nowMode = mode === "now";
  const outside = nowMode ? [] : rows.filter((r) => !days.includes(r.date)); // no period in "Publier maintenant"

  // Free every preview URL when the builder goes away.
  useEffect(() => () => { for (const r of rowsRef.current) if (r.preview) URL.revokeObjectURL(r.preview); }, []);
  // Never lose an in-flight upload by closing the tab.
  useEffect(() => {
    if (!sending) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sending]);

  const update = (ref, patch) => setRows((rs) => rs.map((r) => (r.clientRef === ref ? { ...r, ...patch } : r)));
  const remove = (ref) => setRows((rs) => rs.filter((r) => {
    if (r.clientRef === ref && r.preview) URL.revokeObjectURL(r.preview);
    return r.clientRef !== ref;
  }));
  const duplicate = (ref) => setRows((rs) => {
    const i = rs.findIndex((r) => r.clientRef === ref);
    if (i < 0) return rs;
    const src = rs[i];
    const copy = { ...newRow(src.date), displayName: src.displayName, amount: src.amount, time: src.time };
    return [...rs.slice(0, i + 1), copy, ...rs.slice(i + 1)]; // a receipt is never copied: each proof needs its own
  });

  const payload = (r) => ({
    displayName: r.displayName, amount: r.amount, clientRef: r.clientRef, batchId,
    ...(nowMode ? { publishMode: "now" } : { date: r.date, time: r.time }),
    privacyConfirmed: r.privacy, authenticityConfirmed: r.authenticity,
  });

  const check = async () => {
    setNotice(null);
    if (!rows.length) { setNotice("Ajoutez au moins une preuve."); return; }
    if (outside.length) { setNotice("Certaines preuves sont hors de la période choisie : retirez-les ou élargissez la période."); return; }
    setChecking(true);
    const res = await api("/api/admin/payment-proofs/validate", { method: "POST", body: { items: rows.map(payload) } });
    setChecking(false);
    if (!res.ok) { setNotice(apiErrorText(res)); return; }
    setReview(res.data);
    setPhase("review");
  };

  // Per-row problems in review: server errors + client file check.
  const isDone = (r) => FINAL_STATES.includes(status[r.clientRef]?.state);
  const rowProblems = (r, i) => {
    if (isDone(r)) return []; // already created — kept as is, never resent
    const out = [];
    const item = review?.items?.[i];
    if (item) {
      for (const [field, code] of Object.entries(item.errors || {})) {
        if (field === "duplicateOf") out.push(`Doublon de la preuve n° ${Number(code) + 1} (même nom, montant et ${nowMode ? "publication immédiate" : "heure"})`);
        else out.push(errText(String(code)));
      }
    }
    const fp = fileProblem(r.file);
    if (fp) out.push(fp);
    return out;
  };
  const allValid = review && rows.every((r, i) => rowProblems(r, i).length === 0);

  const submit = async () => {
    setConfirmNow(false);
    setPhase("submit");
    setSending(true);
    for (const r of rowsRef.current) {
      const st = status[r.clientRef]?.state;
      if (FINAL_STATES.includes(st)) continue; // never resend a created row
      setStatus((s) => ({ ...s, [r.clientRef]: { state: "sending" } }));
      const form = new FormData();
      for (const [k, v] of Object.entries(payload(r))) form.append(k, v === true ? "true" : v === false ? "false" : String(v ?? ""));
      form.append("receipt", r.file);
      const res = await api("/api/admin/payment-proofs", { method: "POST", form });
      const pub = res.data?.publication; // "Publier maintenant": the server's publication outcome
      const next = !res.ok
        ? { state: "failed", message: apiErrorText(res) }
        : pub?.status === "PUBLISHED"
          ? { state: "published", message: `le ${fmtInstant(pub.publishedAt)} (heure du Maroc)` }
          : pub?.status === "FAILED"
            ? { state: "pubfailed", message: `${FAILURE_TEXT[pub.reason] || pub.reason || "—"} — corrigez-la dans la liste des preuves` }
            : { state: res.data?.existing ? "existing" : "done" };
      setStatus((s) => ({ ...s, [r.clientRef]: next }));
    }
    setSending(false);
  };

  const states = rows.map((r) => status[r.clientRef]?.state || "pending");
  const failedCount = states.filter((s) => s === "failed").length;
  const finished = phase === "submit" && !sending && states.every((s) => FINAL_STATES.includes(s));

  const startNew = () => {
    for (const r of rows) if (r.preview) URL.revokeObjectURL(r.preview);
    setRows([]); setStatus({}); setReview(null); setBatchId(uuid()); setPhase("edit"); setNotice(null); setConfirmNow(false);
  };

  const grouped = nowMode
    ? [{ date: null, rows: rows.map((r, i) => ({ r, i })) }] // "Publier maintenant": one list, no day
    : days.map((d) => ({ date: d, rows: rows.map((r, i) => ({ r, i })).filter(({ r }) => r.date === d) }));

  // ── 1. Edit ──
  if (phase === "edit") {
    return (
      <div className="space-y-4 min-w-0">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-1 break-words">
          <p className="font-semibold">Avant d&apos;ajouter un reçu :</p>
          <p>• Utilisez uniquement des reçus de paiements réels. Le nom et le montant saisis sont des données d&apos;affichage : ils ne sont liés à aucun compte ni à aucun paiement.</p>
          <p>• Masquez toute donnée sensible (RIB, numéro de compte, téléphone, adresse) avant l&apos;envoi : tous les affiliés actifs voient la même image.</p>
        </div>
        <fieldset className="rounded-2xl border border-gray-200 bg-white p-3 min-w-0" data-publish-mode={mode}>
          <legend className="px-1 text-[11px] font-semibold text-gray-600">Mode de publication</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {PUBLISH_MODES.map(({ id, label, hint, Icon }) => (
              <label key={id} className={`flex items-start gap-2 rounded-xl border p-3 cursor-pointer min-w-0 ${mode === id ? "border-gray-900 bg-gray-50" : "border-gray-200 hover:bg-gray-50"}`}>
                <input type="radio" name="publish-mode" value={id} checked={mode === id} onChange={() => { setMode(id); setNotice(null); }} className="mt-0.5" data-mode-option={id} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900"><Icon className="w-4 h-4 shrink-0" aria-hidden="true" />{label}</span>
                  <span className="block text-[11px] text-gray-500 break-words">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {nowMode ? (
          <section className="rounded-2xl border border-gray-200 bg-gray-50/60 p-3 space-y-2.5 min-w-0" data-now-list>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-gray-900 inline-flex items-center gap-1.5 min-w-0">
                <Send className="w-4 h-4 text-gray-500 shrink-0" aria-hidden="true" />Publication immédiate
                <span className="text-xs font-semibold text-gray-500">· {rows.length} preuve{rows.length > 1 ? "s" : ""}</span>
              </h3>
              <button type="button" className={btnGhost} onClick={() => setRows((rs) => [...rs, newRow(casablancaToday())])}>
                <Plus className="w-3.5 h-3.5" />Ajouter une preuve
              </button>
            </div>
            <p className="text-[11px] text-gray-500">Aucune date ni heure : chaque preuve est publiée dès votre confirmation, puis visible par tous les affiliés actifs pendant {duration}.</p>
            {rows.map((r) => (
              <RowEditor key={r.clientRef} row={r} showTime={false} disabled={isDone(r)} onChange={(p) => update(r.clientRef, p)} onRemove={() => remove(r.clientRef)} onDuplicate={() => duplicate(r.clientRef)} />
            ))}
          </section>
        ) : (<>
        <div className="rounded-2xl border border-gray-200 bg-white p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 min-w-0">
          <label className="block min-w-0">
            <span className="text-[11px] font-semibold text-gray-600">Début de la période (date du Maroc)</span>
            <input type="date" className={inputCls} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label className="block min-w-0">
            <span className="text-[11px] font-semibold text-gray-600">Nombre de jours (1 à 31)</span>
            <input type="number" min={1} max={31} className={inputCls} value={dayCount}
              onChange={(e) => setDayCount(Math.min(31, Math.max(1, Number(e.target.value) || 1)))} />
          </label>
          <p className="sm:col-span-2 text-[11px] text-gray-500">
            Ajoutez vous-même les preuves de chaque jour et l&apos;heure exacte de chacune : rien n&apos;est réparti automatiquement.
            Total : {rows.length} preuve{rows.length > 1 ? "s" : ""}.
          </p>
        </div>

        {grouped.map(({ date, rows: dayRows }) => (
          <section key={date} className="rounded-2xl border border-gray-200 bg-gray-50/60 p-3 space-y-2.5 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-gray-900 inline-flex items-center gap-1.5 min-w-0">
                <CalendarDays className="w-4 h-4 text-gray-500 shrink-0" /><span className="capitalize truncate">{dayLabel(date)}</span>
                <span className="text-xs font-semibold text-gray-500">· {dayRows.length} preuve{dayRows.length > 1 ? "s" : ""}</span>
              </h3>
              <button type="button" className={btnGhost} onClick={() => setRows((rs) => [...rs, newRow(date)])}>
                <Plus className="w-3.5 h-3.5" />Ajouter une preuve
              </button>
            </div>
            {dayRows.map(({ r }) => (
              <RowEditor key={r.clientRef} row={r} disabled={isDone(r)} onChange={(p) => update(r.clientRef, p)} onRemove={() => remove(r.clientRef)} onDuplicate={() => duplicate(r.clientRef)} />
            ))}
          </section>
        ))}

        </>)}

        {outside.length > 0 && (
          <section className="rounded-2xl border border-red-200 bg-red-50 p-3 space-y-2.5 min-w-0">
            <h3 className="text-sm font-bold text-red-800">Hors période ({outside.length}) — retirez ces preuves ou élargissez la période</h3>
            {outside.map((r) => (
              <div key={r.clientRef} className="space-y-1">
                <p className="text-xs text-red-700 capitalize">{dayLabel(r.date)}</p>
                <RowEditor row={r} disabled={isDone(r)} onChange={(p) => update(r.clientRef, p)} onRemove={() => remove(r.clientRef)} onDuplicate={() => duplicate(r.clientRef)} />
              </div>
            ))}
          </section>
        )}

        {notice && <p role="alert" className="text-xs text-red-600">{notice}</p>}
        <div className="flex flex-wrap gap-2 justify-end">
          <button type="button" className={btnPrimary} onClick={check} disabled={checking || !rows.length}>
            {checking && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{nowMode ? "Vérifier les preuves" : "Vérifier le planning"}
          </button>
        </div>
      </div>
    );
  }

  // ── 2. Review / 3. Submit ──
  return (
    <div className="space-y-4 min-w-0">
      <div className="rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-700 space-y-1 min-w-0">
        <p className="font-bold text-gray-900">
          {phase === "review"
            ? (nowMode ? "Vérification avant publication immédiate" : "Vérification du planning")
            : finished ? (nowMode ? "Publication terminée" : "Programmation terminée") : (nowMode ? "Publication en cours" : "Programmation en cours")}
        </p>
        <p className="text-xs text-gray-500 break-words">
          {nowMode
            ? <>{rows.length} preuve{rows.length > 1 ? "s" : ""}. Chaque preuve sera publiée dès votre confirmation (heure réelle du serveur), puis visible par tous les affiliés actifs pendant {duration}.</>
            : <>{rows.length} preuve{rows.length > 1 ? "s" : ""} sur {days.length} jour{days.length > 1 ? "s" : ""}.
              Chaque preuve sera publiée à l&apos;heure indiquée (heure du Maroc), puis visible par tous les affiliés actifs pendant
              la durée d&apos;affichage en vigueur au moment de sa publication{displaySettings?.label ? ` (actuellement ${displaySettings.label})` : ""}.</>}
        </p>
        {phase === "review" && (allValid
          ? <p className="text-xs text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" />Tout est valide.</p>
          : <p className="text-xs text-red-600 inline-flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />Corrigez les erreurs avant de confirmer.</p>)}
      </div>

      {grouped.filter((g) => g.rows.length).map(({ date, rows: dayRows }) => (
        <section key={date} className="rounded-2xl border border-gray-200 bg-white p-3 min-w-0">
          <h3 className="text-sm font-bold text-gray-900 mb-2">
            {date ? <span className="capitalize">{dayLabel(date)}</span> : "Publication immédiate"} · {dayRows.length} preuve{dayRows.length > 1 ? "s" : ""}
          </h3>
          <ul className="divide-y divide-gray-100">
            {[...dayRows].sort((a, b) => (a.r.time < b.r.time ? -1 : a.r.time > b.r.time ? 1 : 0)).map(({ r, i }) => {
              const problems = phase === "review" ? rowProblems(r, i) : [];
              const st = status[r.clientRef];
              return (
                <li key={r.clientRef} className="py-2.5 flex items-start gap-3 min-w-0">
                  <div className="w-12 h-12 rounded-lg border border-gray-200 bg-gray-50 overflow-hidden flex items-center justify-center shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {r.preview ? <img src={r.preview} alt="" className="w-full h-full object-cover" /> : <ImageIcon className="w-4 h-4 text-gray-300" aria-hidden="true" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900 break-words">
                      <span className="tabular-nums">{nowMode ? "Maintenant" : r.time || "--:--"}</span> · {r.displayName || "—"} · {fmtMad(String(r.amount).replace(",", "."))}
                    </p>
                    {problems.map((p) => <p key={p} className="text-[11px] text-red-600 break-words">{p}</p>)}
                    {phase === "submit" && (
                      <p className={`text-[11px] font-semibold inline-flex items-center gap-1 ${st?.state === "failed" || st?.state === "pubfailed" ? "text-red-600" : FINAL_STATES.includes(st?.state) ? "text-emerald-700" : "text-gray-500"}`} data-row-state={st?.state || "pending"}>
                        {st?.state === "sending" && <Loader2 className="w-3 h-3 animate-spin" />}
                        {STATE_TEXT[st?.state || "pending"]}{st?.message ? ` — ${st.message}` : ""}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {notice && <p role="alert" className="text-xs text-red-600">{notice}</p>}
      <div className="flex flex-wrap gap-2 justify-end">
        {phase === "review" && (
          <>
            <button type="button" className={btnGhost} onClick={() => setPhase("edit")}><ArrowLeft className="w-3.5 h-3.5" />Modifier</button>
            {nowMode
              ? <button type="button" className={btnPrimary} onClick={() => setConfirmNow(true)} disabled={!allValid} data-publish-now-open><Send className="w-3.5 h-3.5" />Publier maintenant</button>
              : <button type="button" className={btnPrimary} onClick={submit} disabled={!allValid}>Confirmer et programmer</button>}
          </>
        )}
        {phase === "submit" && !sending && failedCount > 0 && (
          <>
            <button type="button" className={btnGhost} onClick={() => setPhase("edit")}><ArrowLeft className="w-3.5 h-3.5" />Corriger les échecs</button>
            <button type="button" className={btnPrimary} onClick={submit}><RotateCcw className="w-3.5 h-3.5" />Réessayer les échecs ({failedCount})</button>
          </>
        )}
        {finished && (
          <>
            <button type="button" className={btnGhost} onClick={startNew}>Nouveau lot</button>
            <button type="button" className={btnPrimary} onClick={() => { startNew(); onShowList?.(); }}>Voir les preuves</button>
          </>
        )}
      </div>
      {confirmNow && (
        <Modal title="Publier maintenant ?" onClose={() => setConfirmNow(false)}>
          <div className="space-y-3 text-sm text-gray-700" data-publish-now-confirm>
            <p className="break-words">
              {rows.length} preuve{rows.length > 1 ? "s" : ""} {rows.length > 1 ? "seront publiées" : "sera publiée"} <strong>immédiatement</strong> :
              visible{rows.length > 1 ? "s" : ""} par tous les affiliés actifs dans le slider pendant {duration}, à partir de la publication effective.
            </p>
            <p className="text-[11px] text-gray-500">Une preuve publiée ne peut plus être modifiée ni annulée (elle reste dans l&apos;historique).</p>
            <div className="flex flex-wrap gap-2 justify-end">
              <button type="button" className={btnGhost} onClick={() => setConfirmNow(false)} autoFocus>Retour</button>
              <button type="button" className={btnPrimary} onClick={submit} data-publish-now-confirm-button><Send className="w-3.5 h-3.5" />Confirmer la publication</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
