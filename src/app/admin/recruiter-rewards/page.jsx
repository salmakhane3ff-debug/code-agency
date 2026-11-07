"use client";
/**
 * /admin/recruiter-rewards — Affiliate Recruiter System, Phase 5 (admin only; the API
 * refuses anyone else). Reward settings (append-only versions) for Reward A (per affiliate) and
 * Reward B (group reward, Phase 7), recheck, balances per recruiter and the reward ledger. Recruiter withdrawals are processed in the existing
 * withdrawals page (/admin/affiliate-payouts?type=recruiter).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw, Trophy, Save, Wallet } from "lucide-react";

const API = "/api/admin/recruiter-rewards";
const GENERIC_ERROR = "Une erreur est survenue. Veuillez réessayer.";
const FIELD_ERRORS = {
  INVALID_AMOUNT: "Montant invalide (ex. 150 ou 150.50, maximum 1 000 000 MAD).",
  AMOUNT_REQUIRED_WHEN_ENABLED: "Un montant supérieur à 0 est requis pour activer les récompenses.",
  INVALID_COUNT: "Nombre entier entre 1 et 100 000.",
  INVALID_GROUP_SIZE: "Nombre entier entre 1 et 10 000.",
};
const DATE_FMT = new Intl.DateTimeFormat("fr-FR", { timeZone: "Africa/Casablanca", dateStyle: "short", timeStyle: "short" });
const fmtDate = (iso) => (iso ? DATE_FMT.format(new Date(iso)) : "—");
const fmtMad = (cents) => `${(Number(cents || 0) / 100).toFixed(2)} MAD`;
const centsToInput = (cents) => (Number(cents || 0) / 100).toFixed(2);
const TYPE_LABEL = {
  RECRUIT_REWARD: "Récompense", REVERSAL: "Annulation", ADMIN_ADJUSTMENT: "Ajustement",
  GROUP_REWARD: "Récompense de groupe", GROUP_REVERSAL: "Annulation de groupe",
};
const REASON_LABEL = {
  REAL_DELIVERED_AND_CIN_APPROVED: "Commandes réelles livrées + CIN approuvée",
  REAL_DELIVERED_BELOW_THRESHOLD: "Annulation automatique : commandes réelles livrées sous le seuil (annulation / retour)",
  GROUP_QUALIFIED_AFFILIATES: "Groupe d'affiliés qualifiés atteint (commandes réelles livrées + CIN approuvée)",
  GROUP_QUALIFIED_BELOW_THRESHOLD: "Annulation automatique : affiliés qualifiés sous la taille du groupe (annulation / retour)",
};
const FORM_DEFAULTS = {
  enabled: false, rewardAmountMad: "0.00", minDeliveredSales: "10",
  groupEnabled: false, groupRewardAmountMad: "0.00", groupSize: "10", groupMinDeliveredSales: "10",
};
const formOf = (s) => ({
  enabled: s.enabled === true, rewardAmountMad: centsToInput(s.rewardAmountCents), minDeliveredSales: String(s.minDeliveredSales ?? 10),
  groupEnabled: s.groupEnabled === true, groupRewardAmountMad: centsToInput(s.groupRewardAmountCents),
  groupSize: String(s.groupSize ?? 10), groupMinDeliveredSales: String(s.groupMinDeliveredSales ?? 10),
});

function errorText(res, body) {
  if (res.status === 401 || res.status === 403) return "Session expirée ou accès refusé. Reconnectez-vous.";
  return typeof body?.error === "string" ? body.error : GENERIC_ERROR;
}

function Card({ title, icon, children, action }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 space-y-4 min-w-0">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">{icon}{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function AdminRecruiterRewardsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState(FORM_DEFAULTS);
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileMsg, setReconcileMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(API, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) { setLoadError(errorText(res, body)); return; }
      setData(body);
      const s = body.settings || {};
      setForm(formOf(s));
    } catch {
      setLoadError("Erreur réseau.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(null);
    setFieldErrors({});
    try {
      const res = await fetch(`${API}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: form.enabled, rewardAmountMad: form.rewardAmountMad.trim(), minDeliveredSales: form.minDeliveredSales.trim(),
          groupEnabled: form.groupEnabled, groupRewardAmountMad: form.groupRewardAmountMad.trim(),
          groupSize: form.groupSize.trim(), groupMinDeliveredSales: form.groupMinDeliveredSales.trim(),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        if (body?.errors && typeof body.errors === "object") setFieldErrors(body.errors);
        setSaveMsg({ type: "error", text: errorText(res, body) });
        return;
      }
      // Phase 6 part 5d: the save ran the FIRST reconcile batch; the remaining ones run here, one bounded request each.
      const first = body?.reconcile || {};
      const total = first.hasMore && first.cursor ? await reconcileBatches(first.cursor, first) : first;
      const awarded = total.awarded ?? 0;
      const reversed = total.reversed ?? 0;
      const groupAwarded = total.groupAwarded ?? 0;
      const groupReversed = total.groupReversed ?? 0;
      const groupNote = `${groupAwarded ? ` ${groupAwarded} récompense(s) de groupe attribuée(s).` : ""}${groupReversed ? ` ${groupReversed} récompense(s) de groupe annulée(s).` : ""}`;
      // A full check was already running (platform lease): nothing ran for these settings — say so, never a silent success.
      const busyNote = first.busy ? " Une vérification était déjà en cours : relancez « Vérifier » pour appliquer ces réglages à tous les affiliés." : "";
      setSaveMsg({ type: total.error || first.busy ? "error" : "success", text: `Version ${body?.settings?.version ?? "?"} enregistrée.${awarded ? ` ${awarded} récompense(s) attribuée(s).` : ""}${reversed ? ` ${reversed} récompense(s) annulée(s).` : ""}${groupNote}${total.error ? ` Vérification interrompue : ${total.error}` : ""}${busyNote}` });
      await load();
    } catch {
      setSaveMsg({ type: "error", text: "Erreur réseau." });
    } finally {
      setSaving(false);
    }
  };

  // Phase 6 part 5d: one bounded batch per request, repeated with the cursor while hasMore.
  // Each batch is idempotent server-side, so stopping or retrying never duplicates anything.
  const reconcileBatches = async (startCursor = null, start = null) => {
    const total = {
      checked: start?.checked ?? 0, awarded: start?.awarded ?? 0, reversed: start?.reversed ?? 0,
      groupAwarded: start?.groupAwarded ?? 0, groupReversed: start?.groupReversed ?? 0, error: null,
    };
    let cursor = startCursor;
    for (;;) {
      const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reconcile", ...(cursor ? { cursor } : {}) }) });
      const body = await res.json().catch(() => null);
      if (!res.ok) { total.error = errorText(res, body); return total; }
      const r = body?.reconcile || {};
      total.checked += r.checked ?? 0;
      total.awarded += r.awarded ?? 0;
      total.reversed += r.reversed ?? 0;
      total.groupAwarded += r.groupAwarded ?? 0;
      total.groupReversed += r.groupReversed ?? 0;
      if (!r.hasMore || !r.cursor || r.cursor === cursor) return total;
      cursor = r.cursor;
      setReconcileMsg({ type: "success", text: `Vérification en cours… ${total.checked} affilié(s) vérifié(s).` });
    }
  };

  const reconcile = async () => {
    setReconciling(true);
    setReconcileMsg(null);
    try {
      const r = await reconcileBatches();
      if (r.error && !r.checked) { setReconcileMsg({ type: "error", text: r.error }); return; }
      setReconcileMsg({ type: r.error ? "error" : "success", text: `${r.checked} affilié(s) vérifié(s), ${r.awarded} récompense(s) attribuée(s), ${r.reversed} annulée(s) ; groupes : ${r.groupAwarded} attribuée(s), ${r.groupReversed} annulée(s).${r.error ? ` Interrompu : ${r.error}` : ""}` });
      await load();
    } catch {
      setReconcileMsg({ type: "error", text: "Erreur réseau." });
    } finally {
      setReconciling(false);
    }
  };

  if (loading && !data) {
    return <div className="flex justify-center py-32"><Loader2 className="w-8 h-8 animate-spin text-gray-400" /></div>;
  }
  if (loadError && !data) {
    return (
      <div className="py-6 max-w-5xl">
        <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3 text-sm text-red-700 flex items-center justify-between gap-3 flex-wrap" data-error>
          <span>{loadError}</span>
          <button onClick={load} className="px-3 py-1.5 text-xs font-semibold bg-white border border-red-200 rounded-xl">Réessayer</button>
        </div>
      </div>
    );
  }

  const settings = data?.settings || {};
  const history = Array.isArray(data?.history) ? data.history : [];
  const ledger = Array.isArray(data?.ledger) ? data.ledger : [];
  const balances = Array.isArray(data?.balances) ? data.balances : [];
  const Msg = ({ m }) => (m ? (
    <p className={`text-sm rounded-xl px-3 py-2 ${m.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`} role="status">{m.text}</p>
  ) : null);

  return (
    <div className="py-6 max-w-5xl space-y-5" data-admin-recruiter-rewards>
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">Récompenses recruteurs</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Version actuelle : {settings.version ? `v${settings.version}` : "aucune (valeurs par défaut)"} —{" "}
            Récompense A : {settings.enabled ? `activée, ${fmtMad(settings.rewardAmountCents)} par affilié, ${settings.minDeliveredSales} commande(s) réelle(s) livrée(s)` : "désactivée"}
            {" — "}Récompense B (groupe) : {settings.groupEnabled ? `activée, ${fmtMad(settings.groupRewardAmountCents)} par groupe de ${settings.groupSize ?? 10} affilié(s) qualifié(s), ${settings.groupMinDeliveredSales ?? 10} commande(s) réelle(s) livrée(s) chacun` : "désactivée"}
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 rounded-xl">
          <RefreshCw className="w-3.5 h-3.5" /> Actualiser
        </button>
      </div>

      <Card title="Paramètres" icon={<Trophy className="w-4 h-4 text-amber-500" />}>
        <div className="text-sm text-gray-600 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2 space-y-1">
          <p>Un recruteur reçoit <strong>une récompense par affilié de son réseau</strong> (les affiliés qu&apos;il a créés et ceux ajoutés sous eux sans recruteur propre, à toute profondeur — un affilié lié à un autre recruteur appartient à celui-ci avec sa descendance) dès que cet affilié a <strong>les deux conditions</strong> :</p>
          <ul className="list-disc pr-5 pl-5 space-y-0.5">
            <li>au moins <strong>N commandes RÉELLES livrées</strong> (statut « delivered » — les commandes fictives ne comptent jamais) ;</li>
            <li>une <strong>CIN approuvée</strong> par l&apos;administration.</li>
          </ul>
          <p>L&apos;activation du compte de l&apos;affilié n&apos;est pas une condition. Une modification ne s&apos;applique qu&apos;aux récompenses futures : les récompenses déjà attribuées ne changent jamais.</p>
        </div>
        <form onSubmit={save} className="space-y-4" data-settings-form>
          <fieldset className="grid gap-4 sm:grid-cols-2 items-start border border-gray-100 rounded-xl p-3" data-settings-section="individual">
            <legend className="px-1 text-sm font-bold text-gray-800">Récompense A — par affilié</legend>
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 sm:col-span-2">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} className="w-4 h-4" data-field="enabled" />
              Récompenses activées
            </label>
            <div className="space-y-1 min-w-0">
              <label htmlFor="rr-amount" className="text-xs font-semibold text-gray-600">Montant par affilié (MAD)</label>
              <input id="rr-amount" inputMode="decimal" value={form.rewardAmountMad} onChange={(e) => setForm((f) => ({ ...f, rewardAmountMad: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400" data-field="rewardAmountMad" />
              {fieldErrors.rewardAmountMad && <p className="text-xs text-red-600" data-field-error="rewardAmountMad">{FIELD_ERRORS[fieldErrors.rewardAmountMad] ?? "Valeur invalide."}</p>}
            </div>
            <div className="space-y-1 min-w-0">
              <label htmlFor="rr-min" className="text-xs font-semibold text-gray-600">Commandes réelles livrées requises</label>
              <input id="rr-min" inputMode="numeric" value={form.minDeliveredSales} onChange={(e) => setForm((f) => ({ ...f, minDeliveredSales: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400" data-field="minDeliveredSales" />
              {fieldErrors.minDeliveredSales && <p className="text-xs text-red-600" data-field-error="minDeliveredSales">{FIELD_ERRORS[fieldErrors.minDeliveredSales] ?? "Valeur invalide."}</p>}
            </div>
          </fieldset>
          <fieldset className="grid gap-4 sm:grid-cols-3 items-start border border-gray-100 rounded-xl p-3" data-settings-section="group">
            <legend className="px-1 text-sm font-bold text-gray-800">Récompense B — groupe d&apos;affiliés qualifiés</legend>
            <p className="text-xs text-gray-500 sm:col-span-3">
              Le recruteur reçoit ce montant chaque fois que <strong>N affiliés distincts de son réseau</strong> sont chacun qualifiés
              (commandes réelles livrées ≥ le seuil par affilié <strong>et</strong> CIN approuvée). Un affilié compte une seule fois, quel que soit son nombre de ventes ;
              les ventes ne sont jamais additionnées entre affiliés. Si un affilié n&apos;est plus qualifié (annulation / retour), la dernière récompense de groupe non couverte est annulée automatiquement.
            </p>
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 sm:col-span-3">
              <input type="checkbox" checked={form.groupEnabled} onChange={(e) => setForm((f) => ({ ...f, groupEnabled: e.target.checked }))} className="w-4 h-4" data-field="groupEnabled" />
              Récompenses de groupe activées
            </label>
            <div className="space-y-1 min-w-0">
              <label htmlFor="rr-group-amount" className="text-xs font-semibold text-gray-600">Montant par groupe (MAD)</label>
              <input id="rr-group-amount" inputMode="decimal" value={form.groupRewardAmountMad} onChange={(e) => setForm((f) => ({ ...f, groupRewardAmountMad: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400" data-field="groupRewardAmountMad" />
              {fieldErrors.groupRewardAmountMad && <p className="text-xs text-red-600" data-field-error="groupRewardAmountMad">{FIELD_ERRORS[fieldErrors.groupRewardAmountMad] ?? "Valeur invalide."}</p>}
            </div>
            <div className="space-y-1 min-w-0">
              <label htmlFor="rr-group-size" className="text-xs font-semibold text-gray-600">Taille du groupe (affiliés qualifiés)</label>
              <input id="rr-group-size" inputMode="numeric" value={form.groupSize} onChange={(e) => setForm((f) => ({ ...f, groupSize: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400" data-field="groupSize" />
              {fieldErrors.groupSize && <p className="text-xs text-red-600" data-field-error="groupSize">{FIELD_ERRORS[fieldErrors.groupSize] ?? "Valeur invalide."}</p>}
            </div>
            <div className="space-y-1 min-w-0">
              <label htmlFor="rr-group-min" className="text-xs font-semibold text-gray-600">Commandes réelles livrées par affilié</label>
              <input id="rr-group-min" inputMode="numeric" value={form.groupMinDeliveredSales} onChange={(e) => setForm((f) => ({ ...f, groupMinDeliveredSales: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400" data-field="groupMinDeliveredSales" />
              {fieldErrors.groupMinDeliveredSales && <p className="text-xs text-red-600" data-field-error="groupMinDeliveredSales">{FIELD_ERRORS[fieldErrors.groupMinDeliveredSales] ?? "Valeur invalide."}</p>}
            </div>
          </fieldset>
          <div className="sm:max-w-xs">
            <button type="submit" disabled={saving} className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-semibold bg-gray-900 text-white rounded-xl disabled:opacity-50" data-save-settings>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Enregistrer une nouvelle version
            </button>
          </div>
        </form>
        <Msg m={saveMsg} />
      </Card>

      <Card title="Historique des paramètres" icon={null}>
        {history.length === 0 ? (
          <p className="text-sm text-gray-400" data-empty="history">Aucune version : récompenses A et B désactivées, 0 MAD, 10 commandes, groupes de 10 (valeurs par défaut).</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 bg-gray-50">
                {["Version", "A : statut", "A : montant", "A : commandes requises", "B : statut", "B : montant", "B : taille du groupe", "B : commandes par affilié", "Par", "Date"].map((h) => <th key={h} className="text-right text-xs font-semibold text-gray-500 px-3 py-2 whitespace-nowrap">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-gray-50">
                {history.map((h) => (
                  <tr key={h.version}>
                    <td className="px-3 py-2 font-mono">v{h.version}</td>
                    <td className="px-3 py-2">{h.enabled ? "Activées" : "Désactivées"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmtMad(h.rewardAmountCents)}</td>
                    <td className="px-3 py-2">{h.minDeliveredSales}</td>
                    <td className="px-3 py-2">{h.groupEnabled ? "Activées" : "Désactivées"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmtMad(h.groupRewardAmountCents)}</td>
                    <td className="px-3 py-2">{h.groupSize ?? 10}</td>
                    <td className="px-3 py-2">{h.groupMinDeliveredSales ?? 10}</td>
                    <td className="px-3 py-2 text-xs text-gray-500 max-w-[160px] truncate">{h.createdBy || "—"}</td>
                    <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">{fmtDate(h.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Soldes des recruteurs"
        icon={<Wallet className="w-4 h-4 text-indigo-500" />}
        action={(
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={reconcile} disabled={reconciling} className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-amber-50 text-amber-700 hover:bg-amber-100 rounded-xl disabled:opacity-50" data-reconcile>
              {reconciling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Recalculer maintenant
            </button>
            <Link href="/admin/affiliate-payouts?type=recruiter" className="px-3 py-2 text-xs font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-xl" data-payouts-link>
              Retraits des recruteurs
            </Link>
          </div>
        )}
      >
        <Msg m={reconcileMsg} />
        {balances.length === 0 ? (
          <p className="text-sm text-gray-400" data-empty="balances">Aucun recruteur.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 bg-gray-50">
                {["Recruteur", "Gagné", "En attente", "Payé", "Disponible"].map((h) => <th key={h} className="text-right text-xs font-semibold text-gray-500 px-3 py-2 whitespace-nowrap">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-gray-50">
                {balances.map((b) => (
                  <tr key={b.recruiterId} data-balance-row={b.recruiterId}>
                    <td className="px-3 py-2"><p className="font-medium text-gray-800">{b.name || "—"}</p><p className="text-xs text-gray-400 font-mono">@{b.username}</p></td>
                    <td className="px-3 py-2 whitespace-nowrap font-semibold">{fmtMad(b.earnedCents)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-yellow-700">{fmtMad(b.pendingCents)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-green-700">{fmtMad(b.paidCents)}</td>
                    <td className={`px-3 py-2 whitespace-nowrap font-bold ${b.availableCents < 0 ? "text-red-700" : ""}`} data-balance-available={b.availableCents < 0 ? "negative" : "ok"}>
                      {fmtMad(b.availableCents)}{b.availableCents < 0 ? " · solde négatif (annulations)" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Journal des récompenses" icon={<Trophy className="w-4 h-4 text-gray-400" />}>
        {ledger.length === 0 ? (
          <p className="text-sm text-gray-400" data-empty="ledger">Aucune récompense enregistrée.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 bg-gray-50">
                {["Date", "Recruteur", "Affilié", "Type", "Montant", "Version", "Motif"].map((h) => <th key={h} className="text-right text-xs font-semibold text-gray-500 px-3 py-2 whitespace-nowrap">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-gray-50">
                {ledger.map((l) => (
                  <tr key={l.id} data-ledger-row={l.id}>
                    <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">{fmtDate(l.createdAt)}</td>
                    <td className="px-3 py-2 font-mono text-xs">@{l.recruiterUsername || "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{l.affiliateUsername ? `@${l.affiliateUsername}` : l.type === "GROUP_REWARD" || l.type === "GROUP_REVERSAL" ? "Groupe" : "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{TYPE_LABEL[l.type] ?? l.type}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-semibold">{fmtMad(l.amountCents)}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{l.settingsVersion ? `v${l.settingsVersion}` : "—"}{l.cycle ? ` · cycle ${l.cycle}` : ""}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">{REASON_LABEL[l.reason] ?? (l.reason || "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
