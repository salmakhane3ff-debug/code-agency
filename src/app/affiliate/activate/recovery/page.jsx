"use client";
/**
 * /affiliate/activate/recovery — an affiliate reports that their activation code was already
 * used by someone else (Affiliate Recruiter System, Phase 6 part 1, admin recovery).
 * French / LTR like the rest of /affiliate (src/app/affiliate/layout.jsx).
 *
 *   • POST /api/affiliate-activation/recovery { identifier, message, contactPhone? }
 *     → ALWAYS 202 { ok: true } for a well-formed request: this page shows the SAME neutral
 *       message whether or not an account exists (no enumeration).
 * Nothing is stored, no session is used (credentials: 'omit'). Only error CODES are read;
 * server text is never shown.
 */
import { useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, LifeBuoy, Loader2 } from "lucide-react";

const MESSAGE_MIN = 10;
const MESSAGE_MAX = 500;
const PHONE_RE = /^\+?[0-9]{8,15}$/;

const FIELD_TEXT = {
  identifier: { INVALID_IDENTIFIER: "Indiquez votre nom d'utilisateur ou votre numéro de téléphone (3 à 40 caractères)." },
  message: { INVALID_MESSAGE: `Décrivez la situation en ${MESSAGE_MIN} à ${MESSAGE_MAX} caractères (sans < ni >).` },
  contactPhone: { INVALID_PHONE: "Numéro invalide : 8 à 15 chiffres, avec éventuellement + au début." },
  body: { UNKNOWN_FIELD: "Requête invalide." },
};
const ERROR_TEXT = {
  INVALID_INPUT: "Veuillez vérifier les champs indiqués.",
  RATE_LIMITED: "Trop de demandes, réessayez plus tard.",
};
const GENERIC = "Une erreur est survenue. Veuillez réessayer.";
const NEUTRAL_SUCCESS = "Si un compte correspondant existe et peut être récupéré, votre demande a été transmise à l'administration. Vous serez contacté.";

/** Client-side hints only (the server decides). */
function localErrors(identifier, message, phone) {
  const out = {};
  const id = identifier.trim().toLowerCase();
  if (id.length < 3 || id.length > 40 || !/^[a-z0-9._+-]+$/.test(id)) out.identifier = "INVALID_IDENTIFIER";
  const msg = message.replace(/\s+/g, " ").trim();
  if (msg.length < MESSAGE_MIN || msg.length > MESSAGE_MAX || /[<>]/.test(msg)) out.message = "INVALID_MESSAGE";
  const p = phone.replace(/[\s.-]/g, "");
  if (p && !PHONE_RE.test(p)) out.contactPhone = "INVALID_PHONE";
  return out;
}

const fieldText = (field, c) => (c && FIELD_TEXT[field]?.[c]) || (c ? "Valeur invalide." : "");

export default function AffiliateActivationRecoveryPage() {
  const [identifier, setIdentifier] = useState("");
  const [message, setMessage] = useState("");
  const [phone, setPhone] = useState("");
  const [fields, setFields] = useState({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const edit = (setter, field) => (e) => {
    setter(e.target.value);
    if (fields[field] || fields.body) setFields((f) => { const n = { ...f }; delete n[field]; delete n.body; return n; });
    if (error) setError("");
  };

  async function handleSubmit(e) {
    e.preventDefault();
    if (loading) return;
    setError("");
    const local = localErrors(identifier, message, phone);
    if (Object.keys(local).length) { setFields(local); setError(ERROR_TEXT.INVALID_INPUT); return; }
    setFields({});
    setLoading(true);
    try {
      const p = phone.trim();
      const res = await fetch("/api/affiliate-activation/recovery", {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: identifier.trim().toLowerCase(),
          message: message.replace(/\s+/g, " ").trim(),
          ...(p ? { contactPhone: p } : {}),
        }),
      });
      if (res.status === 202 || res.ok) {
        // Same neutral answer for every well-formed request.
        setDone(true);
        setIdentifier(""); setMessage(""); setPhone("");
        return;
      }
      const body = await res.json().catch(() => null);
      const code = typeof body?.code === "string" ? body.code : "";
      if (code === "INVALID_INPUT" && body?.fields && typeof body.fields === "object") {
        const f = {};
        for (const k of Object.keys(FIELD_TEXT)) if (typeof body.fields[k] === "string" && FIELD_TEXT[k][body.fields[k]]) f[k] = body.fields[k];
        setFields(f);
      }
      setError(ERROR_TEXT[code] || GENERIC);
    } catch {
      setError(GENERIC);
    } finally {
      setLoading(false);
    }
  }

  const msgLen = message.replace(/\s+/g, " ").trim().length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm min-w-0">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-white/10 rounded-2xl mb-4 backdrop-blur">
            <LifeBuoy className="w-8 h-8 text-white" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold text-white">Mon code d&apos;activation a déjà été utilisé</h1>
          <p className="text-gray-400 text-sm mt-1" dir="rtl" lang="ar">إذا استعمل شخص آخر رمز التفعيل الخاص بك، أبلغ الإدارة هنا.</p>
        </div>

        <div className="bg-white rounded-3xl shadow-2xl p-7 space-y-5">
          {done ? (
            <div className="space-y-4 text-center" data-recovery-success role="status">
              <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto" aria-hidden="true" />
              <p className="text-sm text-gray-700">{NEUTRAL_SUCCESS}</p>
              <Link href="/affiliate/activate" className="inline-flex items-center justify-center w-full py-3 bg-gray-900 hover:bg-gray-800 text-white rounded-xl font-bold text-sm">
                Retour à l&apos;activation
              </Link>
            </div>
          ) : (
            <>
              <div className="text-sm text-gray-600 space-y-2 bg-gray-50 border border-gray-100 rounded-2xl px-4 py-3" data-recovery-explanation>
                <p>Si quelqu&apos;un a utilisé votre code d&apos;activation avant vous, signalez-le ici.</p>
                <p>Un administrateur vérifiera votre identité (il peut vous appeler), puis vous remettra directement un nouveau code. Votre recruteur ne le recevra pas.</p>
                <p>Votre compte reste en attente jusqu&apos;à sa validation par l&apos;administration.</p>
              </div>

              {error && (
                <div className="flex items-start gap-2.5 bg-red-50 border border-red-100 rounded-2xl px-4 py-3" role="alert" data-recovery-error>
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" aria-hidden="true" />
                  <p className="text-sm text-red-600">{error}</p>
                </div>
              )}

              <form onSubmit={handleSubmit} noValidate className="space-y-4">
                <div className="min-w-0">
                  <label htmlFor="rec-identifier" className="block text-xs font-semibold text-gray-600 mb-1.5">Identifiant (nom d&apos;utilisateur ou téléphone)</label>
                  <input id="rec-identifier" type="text" value={identifier} onChange={edit(setIdentifier, "identifier")} maxLength={40}
                    autoComplete="username" autoCapitalize="none" spellCheck={false} aria-invalid={!!fields.identifier}
                    className={`w-full min-w-0 px-4 py-3 text-sm border rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400 ${fields.identifier ? "border-red-300" : "border-gray-200"}`}
                    dir="ltr" data-recovery-identifier />
                  {fields.identifier && <p className="mt-1 text-xs text-red-600" data-field-error="identifier">{fieldText("identifier", fields.identifier)}</p>}
                </div>

                <div className="min-w-0">
                  <label htmlFor="rec-message" className="block text-xs font-semibold text-gray-600 mb-1.5">Message</label>
                  <textarea id="rec-message" value={message} onChange={edit(setMessage, "message")} rows={4} maxLength={MESSAGE_MAX}
                    aria-invalid={!!fields.message} placeholder="Expliquez ce qui s'est passé (ex. : mon code était déjà utilisé quand je l'ai saisi)."
                    className={`w-full min-w-0 px-4 py-3 text-sm border rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400 resize-none ${fields.message ? "border-red-300" : "border-gray-200"}`}
                    data-recovery-message />
                  <div className="flex items-start justify-between gap-2 mt-1">
                    {fields.message
                      ? <p className="text-xs text-red-600" data-field-error="message">{fieldText("message", fields.message)}</p>
                      : <span />}
                    <span className={`text-xs shrink-0 ${msgLen > MESSAGE_MAX || (msgLen > 0 && msgLen < MESSAGE_MIN) ? "text-red-500" : "text-gray-400"}`} data-recovery-counter>
                      {msgLen}/{MESSAGE_MAX}
                    </span>
                  </div>
                </div>

                <div className="min-w-0">
                  <label htmlFor="rec-phone" className="block text-xs font-semibold text-gray-600 mb-1.5">Téléphone de contact (facultatif)</label>
                  <input id="rec-phone" type="tel" inputMode="tel" value={phone} onChange={edit(setPhone, "contactPhone")} maxLength={20}
                    autoComplete="tel" aria-invalid={!!fields.contactPhone} placeholder="06XXXXXXXX"
                    className={`w-full min-w-0 px-4 py-3 text-sm border rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400 ${fields.contactPhone ? "border-red-300" : "border-gray-200"}`}
                    dir="ltr" data-recovery-phone />
                  {fields.contactPhone && <p className="mt-1 text-xs text-red-600" data-field-error="contactPhone">{fieldText("contactPhone", fields.contactPhone)}</p>}
                  {fields.body && <p className="mt-1 text-xs text-red-600" data-field-error="body">{fieldText("body", fields.body)}</p>}
                </div>

                <button type="submit" disabled={loading} data-recovery-submit
                  className="w-full flex items-center justify-center gap-2 py-3 bg-gray-900 hover:bg-gray-800 text-white rounded-xl font-bold text-sm transition-all disabled:opacity-50 active:scale-[0.99]">
                  {loading ? <><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Envoi...</> : <><LifeBuoy className="w-4 h-4" aria-hidden="true" /> Envoyer la demande</>}
                </button>
              </form>

              <p className="text-center text-xs text-gray-400 pt-1">
                <Link href="/affiliate/activate" className="text-gray-600 font-medium underline">Retour à l&apos;activation</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
