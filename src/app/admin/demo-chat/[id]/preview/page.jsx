"use client";

/**
 * /admin/demo-chat/:id/preview[?version=<id>] — 30-day timeline of a draft or a
 * published version (Phase 3C-2). Writes nothing. Earnings messages show
 * labelled SAMPLE values — never real or demo figures.
 * Phase 3C-4: "Planning" panel — what a chosen demo profile would see at a
 * chosen Casablanca date/time for a hypothetical day-1 date, with earnings
 * read from that profile's DEMO history (unavailable data is never shown as 0).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Loader2, ArrowLeft, Info, CalendarClock } from "lucide-react";
import { localParts, CHAT_TIMEZONE } from "@/lib/demoChatTime";
import { api, field, DemoBadge, SimulationBadge, ErrorBox, TYPE_LABEL, AssetThumb } from "../../ui";

const STATE_STYLE = {
  ok: null,
  provisional: { label: "Provisoire", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  unavailable: { label: "Données indisponibles", cls: "bg-gray-100 text-gray-700 border-gray-200" },
  invalid: { label: "Invalide", cls: "bg-red-50 text-red-700 border-red-200" },
};

function SchedulePreview({ journeyId, versionId }) {
  const now = localParts(Date.now(), CHAT_TIMEZONE);
  const [profiles, setProfiles] = useState([]);
  const [form, setForm] = useState({ demoAffiliateId: "", anchorDate: now.date, atDate: now.date, atTime: now.time, locale: "ar" });
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  useEffect(() => {
    api("/api/admin/demo/profiles?status=all").then((d) => { setProfiles(d.profiles || []); if (d.profiles?.[0]) set("demoAffiliateId", d.profiles[0].id); }, (e) => setError(e.message));
  }, []);
  const run = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { setRes(await api("/api/admin/demo-chat/preview/schedule", "POST", { journeyId, versionId, ...form })); }
    catch (e2) { setError(e2.message); setRes(null); } finally { setBusy(false); }
  };
  return (
    <section className="p-4 rounded-2xl border border-gray-100 bg-white space-y-3">
      <h2 className="text-sm font-bold text-gray-900 flex items-center gap-2"><CalendarClock className="w-4 h-4" /> Planning — ce que verrait un profil démo</h2>
      <form onSubmit={run} className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end">
        <label className="text-[11px] text-gray-500 col-span-2">Profil démo
          <select className={field} value={form.demoAffiliateId} onChange={(e) => set("demoAffiliateId", e.target.value)}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name} (@{p.username}){p.isActive ? "" : " — inactif"}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-gray-500">Jour 1 (date)
          <input type="date" className={field} value={form.anchorDate} onChange={(e) => set("anchorDate", e.target.value)} />
        </label>
        <label className="text-[11px] text-gray-500">À la date
          <input type="date" className={field} value={form.atDate} onChange={(e) => set("atDate", e.target.value)} />
        </label>
        <label className="text-[11px] text-gray-500">Heure (Casablanca)
          <input type="time" className={field} value={form.atTime} onChange={(e) => set("atTime", e.target.value)} />
        </label>
        <label className="text-[11px] text-gray-500">Langue des montants
          <select className={field} value={form.locale} onChange={(e) => set("locale", e.target.value)}><option value="ar">Darija</option><option value="fr">Français</option></select>
        </label>
        <button disabled={busy || !form.demoAffiliateId} className="px-3 py-2 bg-indigo-600 text-white text-xs font-bold rounded-xl disabled:opacity-50">{busy ? "…" : "Afficher"}</button>
      </form>
      <ErrorBox error={error} />
      {res && (
        <div className="space-y-2">
          <p className="text-[11px] text-indigo-900 bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-2">{res.disclosure}</p>
          <p className="text-xs text-gray-600">
            {res.cycle.started
              ? <>Cycle {res.cycle.loopIndex + 1} · jour {res.cycle.day}/30 ({res.cycle.cycleStart} → {res.cycle.cycleEnd}){res.cycle.previousCyclesHidden ? ` · ${res.cycle.previousCyclesHidden} cycle(s) précédent(s) masqué(s)` : ""}</>
              : <>Le parcours commence le {res.cycle.startsOn} : aucun message visible.</>}
            {" "}· {res.messages.length} message(s) visible(s) au {res.atLocal.date} {res.atLocal.time} ({res.timezone}).
          </p>
          {res.messages.map((m) => {
            const st = STATE_STYLE[m.state];
            return (
              <div key={`${m.loopIndex}-${m.stepId}`} className="max-w-md p-3 rounded-2xl rounded-tl-sm bg-white border border-gray-100 shadow-sm">
                {m.asset && <div className="mb-1"><AssetThumb asset={m.asset} /></div>}
                {m.text && <p className="text-sm text-gray-900 whitespace-pre-wrap break-words" dir="auto">{m.text}</p>}
                <p className="mt-1 text-[10px] text-gray-400">
                  {m.date} {m.localTime} · jour {m.day} · {TYPE_LABEL[m.type]}{m.metricLabel ? ` · ${m.metricLabel}` : ""}{m.timeAdjustment ? ` · heure ajustée (${m.timeAdjustment})` : ""}
                </p>
                {st && <p className={`mt-1 inline-block text-[10px] font-bold px-2 py-0.5 rounded-full border ${st.cls}`}>{st.label}{m.earnings?.reason ? ` — ${m.earnings.reason}` : ""}</p>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function DemoChatPreviewPage() {
  const { id } = useParams();
  const versionId = useSearchParams().get("version") || undefined;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [onlyFilled, setOnlyFilled] = useState(true);

  useEffect(() => {
    api("/api/admin/demo-chat/preview", "POST", { journeyId: id, versionId }).then(setData, (e) => setError(e.message));
  }, [id, versionId]);

  if (!data) return <div className="p-6">{error ? <ErrorBox error={error} /> : <Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" />}</div>;
  const days = onlyFilled ? data.days.filter((d) => d.messages.length) : data.days;

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-4">
      <Link href={`/admin/demo-chat/${id}`} className="text-xs font-bold text-gray-500 hover:text-gray-900 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Retour au parcours</Link>
      <h1 className="text-lg font-black text-gray-900 flex flex-wrap items-center gap-2">
        Aperçu {data.source.kind === "version" ? `— version ${data.source.version}` : "— brouillon"} <DemoBadge /> <SimulationBadge />
      </h1>
      <div className="flex items-start gap-2 p-3 rounded-xl bg-indigo-50 border border-indigo-100 text-xs text-indigo-900">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <p>{data.disclosure} Heures affichées : fuseau {data.timezone}. Exemples utilisés : {"{amount}"} = {data.sampleValues.amount}, {"{orders}"} = {data.sampleValues.orders}.</p>
      </div>
      <SchedulePreview journeyId={id} versionId={versionId} />
      <h2 className="text-sm font-bold text-gray-900 pt-2">Chronologie complète (valeurs d'exemple)</h2>
      <label className="text-xs text-gray-600 flex items-center gap-2"><input type="checkbox" checked={onlyFilled} onChange={(e) => setOnlyFilled(e.target.checked)} /> Masquer les jours sans message</label>
      {days.map((d) => (
        <div key={d.day} className="space-y-2">
          <p className="text-[11px] font-black text-gray-500 uppercase">Jour {d.day}</p>
          {d.messages.length === 0 && <p className="text-xs text-gray-400">—</p>}
          {d.messages.map((m) => (
            <div key={m.id} className="max-w-md p-3 rounded-2xl rounded-tl-sm bg-white border border-gray-100 shadow-sm">
              {m.asset && <div className="mb-1"><AssetThumb asset={m.asset} /></div>}
              {m.text && <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{m.text}</p>}
              <p className="mt-1 text-[10px] text-gray-400">{m.time} · {TYPE_LABEL[m.type]}{m.usesSampleValues ? " · valeurs d'exemple" : ""}</p>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
