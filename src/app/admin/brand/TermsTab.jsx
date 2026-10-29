"use client";

import { useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { api, inputCls, btnPrimary, btnGhost, FieldError } from "./ui";

const fmt = (d) => (d ? new Date(d).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }) : "—");

/**
 * Training-service refund terms. The draft is never shown to affiliates; only a
 * version an administrator approves and publishes is. Nothing ships pre-written.
 */
export default function TermsTab() {
  const [terms, setTerms] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [errors, setErrors] = useState({});

  const apply = (t) => { setTerms(t); setDraft(t.draft.text || ""); };
  useEffect(() => { api("/api/admin/brand/terms").then((r) => (r.ok ? apply(r.data) : setNotice({ ok: false, text: r.error }))); }, []);

  const saveDraft = async () => {
    setBusy("draft"); setNotice(null);
    const r = await api("/api/admin/brand/terms", { method: "PUT", body: { text: draft } });
    setBusy(null);
    if (r.ok) { apply(r.data); setErrors({}); setNotice({ ok: true, text: "Brouillon enregistré (non visible par les affiliés)." }); }
    else { setErrors(r.data?.errors || {}); setNotice({ ok: false, text: r.error }); }
  };
  const publish = async () => {
    if (!window.confirm("Approuver ce brouillon et le publier ? Les affiliés devront accepter cette version pour acheter.")) return;
    setBusy("publish"); setNotice(null);
    const r = await api("/api/admin/brand/terms/publish", { method: "POST", body: {} });
    setBusy(null);
    if (r.ok) { apply(r.data); setNotice({ ok: true, text: `Version ${r.data.published.version} publiée.` }); }
    else setNotice({ ok: false, text: r.error });
  };

  if (!terms) return <div className="py-10 flex justify-center">{notice ? <p className="text-sm text-red-600">{notice.text}</p> : <Loader2 className="w-6 h-6 animate-spin text-gray-400" />}</div>;
  const dirty = draft !== (terms.draft.text || "");
  const sameAsPublished = !!terms.published && terms.published.text === terms.draft.text;

  return (
    <div className="space-y-4">
      {notice && <p className={`text-sm rounded-xl px-3 py-2 border ${notice.ok ? "text-emerald-700 bg-emerald-50 border-emerald-100" : "text-red-600 bg-red-50 border-red-100"}`}>{notice.text}</p>}

      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
        <p className="text-sm font-bold text-gray-900">Brouillon</p>
        <p className="text-xs text-gray-500">Rédigez ou collez ici les conditions de remboursement du service de formation validées par votre responsable juridique. Rien n’est pré-rédigé.</p>
        <textarea className={inputCls} rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <FieldError code={errors.text} />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={saveDraft} disabled={!dirty || busy} className={btnGhost}>{busy === "draft" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Enregistrer le brouillon</button>
          <button type="button" onClick={publish} disabled={dirty || busy || !terms.draft.text || sameAsPublished} className={btnPrimary}>
            {busy === "publish" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}Approuver et publier
          </button>
          {dirty && <span className="text-xs text-amber-700">Enregistrez le brouillon avant de le publier.</span>}
          {!dirty && sameAsPublished && <span className="text-xs text-gray-400">Ce brouillon est déjà la version publiée.</span>}
        </div>
        {terms.draft.updatedAt && <p className="text-[11px] text-gray-400">Brouillon modifié le {fmt(terms.draft.updatedAt)}</p>}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-2">
        <p className="text-sm font-bold text-gray-900">Version publiée</p>
        {terms.published ? (
          <>
            <p className="text-xs text-gray-500">Version {terms.published.version} · publiée le {fmt(terms.published.publishedAt)}</p>
            <div className="max-h-64 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-700 whitespace-pre-line">{terms.published.text}</div>
          </>
        ) : <p className="text-xs text-amber-700">Aucune version publiée : les affiliés ne peuvent pas acheter.</p>}
      </div>
    </div>
  );
}
