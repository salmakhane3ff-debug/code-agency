"use client";
// Shared client helpers of /admin/demo-competition/ugc-videos (SIMULATION ONLY — demo videos, simulated sales and rewards).
// Every request goes through dcApi (../../_components/ui): JSON bodies get application/json, FormData uploads get NO
// hand-set Content-Type (the browser adds multipart/form-data with its boundary).

import { useRef, useState } from "react";
import { Upload, Loader2, Film, ImageIcon, X, FlaskConical } from "lucide-react";
import { UGC_MEDIA } from "@/lib/demoCompUgc";
import { dcApi, btnGhost } from "../../_components/ui";

/** Path prefix of the UGC Videos admin API, relative to the Demo Competition admin API base used by dcApi. */
export const UGC = "/ugc-videos";

// ── Error codes → French ─────────────────────────────────────────────────────

/** Top-level API codes of the UGC Videos admin routes → French. */
export const UGC_CODE_TEXT = {
  INVALID_JSON: "Requête invalide (contenu JSON attendu).",
  INVALID_SETTINGS: "Paramètres invalides — corrigez les champs signalés.",
  MEMBER_NOT_FOUND: "Membre démo propriétaire introuvable : choisissez-en un autre.",
  NOT_FOUND: "Vidéo UGC démo introuvable (elle a peut-être été modifiée ailleurs) — actualisez la page.",
  ARCHIVED: "Cette vidéo démo est retirée (archivée) : restaurez-la avant de la modifier ou d'y téléverser un fichier.",
  VIDEO_LIMIT_REACHED: "Limite atteinte : 100 vidéos UGC démo maximum (hors vidéos retirées). Retirez-en une pour en créer ou en restaurer une autre.",
  MEMBER_ARCHIVED: "Le membre démo propriétaire est archivé : restaurez-le d'abord dans Demo Members.",
  NO_MEMBERS: "Aucun membre démo non archivé : créez d'abord des membres démo (ce sont les propriétaires des vidéos).",
  UGC_DISABLED: "Le module UGC Videos est désactivé : activez-le avant d'exécuter une génération.",
  INVALID_INPUT: "Requête invalide (aucun fichier reçu dans le champ « file »).",
  INVALID_FILE_TYPE: "Format de fichier non accepté.",
  FILE_TOO_LARGE: "Fichier trop lourd.",
  EMPTY_FILE: "Fichier vide.",
  SERVER_ERROR: "Erreur serveur — réessayez.",
};

/** Field-level validation codes (INVALID_SETTINGS / MEMBER_NOT_FOUND `fields`) → French. */
export const UGC_FIELD_TEXT = {
  INVALID_TYPE: "Type de valeur invalide.",
  INVALID_TITLE: "Titre requis (1 à 120 caractères, sans < ni >).",
  MEMBER_REQUIRED: "Choisissez un membre démo propriétaire.",
  MEMBER_ARCHIVED: "Ce membre démo est archivé : choisissez un membre non archivé (ou restaurez-le).",
  MEMBER_NOT_FOUND: "Membre démo introuvable : choisissez-en un autre.",
  INVALID_MIN_SALES: "Nombre entier entre 0 et 1000 ventes simulées par jour.",
  INVALID_MAX_SALES: "Nombre entier entre 0 et 1000 ventes simulées par jour.",
  MAX_BELOW_MIN: "Le maximum doit être supérieur ou égal au minimum.",
  INVALID_REWARD: "Récompense simulée : 5, 6 ou 7 DH par vente uniquement.",
  INVALID_ACTIVE: "Valeur invalide (actif : oui ou non).",
  INVALID_SORT_ORDER: "Nombre entier entre 0 et 1 000 000.",
  INVALID_MEDIA_URL: "Fichier non reconnu : téléversez-le avec le bouton (stockage démo dédié uniquement).",
  INVALID_TARGET_COUNT: "Nombre entier entre 1 et 100.",
  INVALID_ENABLED: "Valeur invalide (module activé : oui ou non).",
};

// ── Uploads ──────────────────────────────────────────────────────────────────

/** Fallback of the `uploads` block of GET state (same values as the server: video ≤ 50 MB, thumbnail ≤ 5 MB). */
export const DEFAULT_UPLOADS = {
  field: "file",
  video: { maxBytes: UGC_MEDIA.video.maxBytes, extensions: [...UGC_MEDIA.video.exts], accept: "video/mp4,video/webm,video/quicktime" },
  thumbnail: { maxBytes: UGC_MEDIA.thumbnail.maxBytes, extensions: [...UGC_MEDIA.thumbnail.exts], accept: "image/jpeg,image/png,image/webp" },
};

const KIND_LABEL = { video: "Vidéo", thumbnail: "Miniature" };

/** bytes → "50 Mo". */
export const fmtMb = (bytes) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format((Number(bytes) || 0) / 1048576)} Mo`;

/** Client-side pre-check from the server `uploads` spec (extension allow-list, empty file, size cap). → error code or null. */
export function checkUgcFile(kind, file, uploads) {
  const spec = uploads?.[kind];
  if (!spec) return "INVALID_INPUT";
  if (!file) return "EMPTY_FILE";
  const name = String(file.name || "");
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  if (!spec.extensions.includes(ext)) return "INVALID_FILE_TYPE";
  if (!(file.size > 0)) return "EMPTY_FILE";
  if (file.size > spec.maxBytes) return "FILE_TOO_LARGE";
  return null;
}

/** French text of an upload error code for one kind ("Format non accepté : .mp4, .webm, .mov"). */
export function uploadCodeText(code, kind, uploads) {
  const spec = uploads?.[kind];
  if (code === "INVALID_FILE_TYPE" && spec) return `${UGC_CODE_TEXT.INVALID_FILE_TYPE} ${KIND_LABEL[kind]} : ${spec.extensions.join(", ")} uniquement.`;
  if (code === "FILE_TOO_LARGE" && spec) return `${UGC_CODE_TEXT.FILE_TOO_LARGE} ${KIND_LABEL[kind]} : ${fmtMb(spec.maxBytes)} maximum.`;
  return UGC_CODE_TEXT[code] || code;
}

/** French message of a failed dcApi result (session / network messages of dcApi kept, UGC codes mapped here). */
export function ugcErrorText(r, kind, uploads) {
  if (!r || r.ok) return null;
  if (r.status === 401 || r.status === 403 || r.code === "NETWORK" || !r.code) return r.error;
  if (kind && (r.code === "INVALID_FILE_TYPE" || r.code === "FILE_TOO_LARGE")) return uploadCodeText(r.code, kind, uploads);
  return UGC_CODE_TEXT[r.code] || r.error;
}

// ── Components ───────────────────────────────────────────────────────────────

/** "SIMULATION · DÉMO" pill shown next to every UGC title. */
export function SimBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-200" data-ugc-simulation>
      <FlaskConical className="w-3 h-3" /> SIMULATION · DÉMO
    </span>
  );
}

/** Module-specific disclosure (in addition to the shared SimulationNotice). */
export function UgcSimulationNote() {
  return (
    <p className="text-[11px] leading-relaxed text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
      <strong>DÉMO :</strong> les vidéos UGC de ce module, leurs ventes et leurs récompenses (5, 6 ou 7 DH par vente) sont
      <strong> simulées</strong> par le serveur. Ce ne sont ni de vraies soumissions UGC, ni de vraies commandes, ni des gains
      retirables : aucun lien avec le module UGC réel, les portefeuilles ou les paiements.
    </p>
  );
}

export function UgcFieldError({ code }) {
  const msg = code ? UGC_FIELD_TEXT[code] || UGC_CODE_TEXT[code] || code : null;
  return msg ? <p className="text-[11px] text-red-600 mt-1" data-ugc-field-error>{msg}</p> : null;
}

export function UgcField({ label, hint, error, children }) {
  return (
    <label className="block min-w-0">
      <span className="block text-xs font-semibold text-gray-600 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-gray-400 mt-1">{hint}</span>}
      <UgcFieldError code={error} />
    </label>
  );
}

/** Small on/off switch (role="switch"); extra props (data attributes, aria-label) go on the button. */
export function Switch({ checked, onChange, disabled, label, ...rest }) {
  return (
    <button
      type="button" role="switch" aria-checked={!!checked} disabled={disabled} onClick={() => onChange(!checked)} {...rest}
      className={`relative inline-flex shrink-0 w-10 h-6 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${checked ? "bg-blue-600" : "bg-gray-300"}`}
    >
      <span className="sr-only">{label}</span>
      <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${checked ? "start-[18px]" : "start-0.5"}`} />
    </button>
  );
}

const pill = "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border whitespace-nowrap";

/** Why a non-archived video is not in the public leaderboard (null when listed). */
export function unlistedReason(v, enabled) {
  if (v.archivedAt) return "retirée (archivée)";
  if (!v.videoUrl) return "non visible — pas de fichier vidéo";
  if (!v.active) return "désactivée";
  if (v.owner?.archivedAt) return "propriétaire archivé";
  if (!enabled) return "module désactivé";
  return v.listed ? null : "hors classement";
}

/** Status badges of a video: Retirée / Active / Désactivée + Listée / Non listée (+ reason) + no file. */
export function VideoBadges({ v, enabled }) {
  const reason = unlistedReason(v, enabled);
  return (
    <span className="flex flex-wrap gap-1">
      {v.archivedAt
        ? <span className={`${pill} bg-amber-50 text-amber-800 border-amber-200`}>Retirée (archivée)</span>
        : v.active
          ? <span className={`${pill} bg-green-50 text-green-700 border-green-200`}>Active</span>
          : <span className={`${pill} bg-gray-100 text-gray-500 border-gray-200`}>Désactivée</span>}
      {!v.archivedAt && (v.listed && !reason
        ? <span className={`${pill} bg-blue-50 text-blue-700 border-blue-200`}>Listée publiquement</span>
        : <span className={`${pill} bg-gray-50 text-gray-600 border-gray-200`}>Non listée</span>)}
      {!v.videoUrl && <span className={`${pill} bg-red-50 text-red-700 border-red-200`} data-ugc-no-file>Non visible — pas de fichier vidéo</span>}
      {v.owner?.archivedAt && <span className={`${pill} bg-amber-50 text-amber-800 border-amber-200`}>Propriétaire archivé</span>}
    </span>
  );
}

/** 9:16 thumbnail (or a placeholder tile). */
export function Thumb({ url, title, className = "w-14 h-20" }) {
  return url
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={url} alt={title || ""} className={`${className} rounded-xl object-cover bg-gray-100 border border-gray-100 shrink-0`} />
    : (
      <span className={`${className} rounded-xl bg-gray-100 border border-dashed border-gray-300 text-gray-400 inline-flex flex-col items-center justify-center shrink-0`} title="Aucune miniature">
        <Film className="w-5 h-5" />
        <span className="text-[9px] mt-0.5">DÉMO</span>
      </span>
    );
}

/** Video preview: controls, never autoplay (metadata only until the admin presses play). */
export function VideoPreview({ url, poster }) {
  if (!url) return null;
  return (
    <video
      src={url} poster={poster || undefined} controls preload="metadata" playsInline
      className="w-full max-w-[240px] aspect-[9/16] rounded-xl bg-black object-contain"
    >
      Votre navigateur ne lit pas cette vidéo.
    </video>
  );
}

/**
 * Upload of one media file (multipart field "file") through dcApi — no hand-set Content-Type.
 * `path`: /ugc-videos/videos/{id}/{kind} (attached at once) or /ugc-videos/upload/{kind} (before creation).
 * dcApi has no progress callback → spinner while the request runs. onUploaded(url, data).
 */
export function MediaUploader({ kind, path, url, poster, uploads, disabled, onUploaded, onRemove, pending }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(null); // { name, size } while uploading
  const [error, setError] = useState(null);
  const spec = uploads?.[kind] || DEFAULT_UPLOADS[kind];

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const bad = checkUgcFile(kind, file, uploads || DEFAULT_UPLOADS);
    if (bad) { setError(uploadCodeText(bad, kind, uploads || DEFAULT_UPLOADS)); return; }
    setError(null);
    setBusy({ name: file.name, size: file.size });
    const form = new FormData();
    form.append("file", file);
    const r = await dcApi(path, { method: "POST", form });
    setBusy(null);
    if (r.ok && r.data?.url) onUploaded(r.data.url, r.data);
    else setError(ugcErrorText(r, kind, uploads || DEFAULT_UPLOADS) || UGC_CODE_TEXT.SERVER_ERROR);
  };

  return (
    <div className="space-y-2 min-w-0" data-ugc-upload={kind}>
      {kind === "video"
        ? (url ? <VideoPreview url={url} poster={poster} /> : (
          <div className="w-full max-w-[240px] aspect-[9/16] rounded-xl border border-dashed border-red-200 bg-red-50 text-red-700 text-xs flex flex-col items-center justify-center gap-1 p-3 text-center">
            <Film className="w-6 h-6" /> Pas de fichier vidéo : la vidéo reste non visible publiquement.
          </div>
        ))
        : <Thumb url={url} className="w-24 h-36" />}
      <input ref={inputRef} type="file" accept={`${spec.accept},${spec.extensions.join(",")}`} className="hidden" onChange={pick} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnGhost} disabled={disabled || !!busy} onClick={() => inputRef.current?.click()}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : kind === "video" ? <Upload className="w-3.5 h-3.5" /> : <ImageIcon className="w-3.5 h-3.5" />}
          {busy ? "Téléversement…" : url ? `Remplacer ${kind === "video" ? "la vidéo" : "la miniature"}` : `Téléverser ${kind === "video" ? "une vidéo" : "une miniature"}`}
        </button>
        {url && onRemove && (
          <button type="button" className={btnGhost} disabled={disabled || !!busy} onClick={onRemove}>
            <X className="w-3.5 h-3.5" /> Retirer le fichier
          </button>
        )}
      </div>
      {busy && <p className="text-[11px] text-blue-700">Téléversement de « {busy.name} » ({fmtMb(busy.size)}) en cours… ne fermez pas ce panneau.</p>}
      <p className="text-[11px] text-gray-400">{spec.extensions.join(", ")} · {fmtMb(spec.maxBytes)} maximum{kind === "thumbnail" ? " · convertie en WebP" : ""}</p>
      {pending && <p className="text-[11px] text-amber-700">Modification non enregistrée : cliquez sur « Enregistrer ».</p>}
      {error && <p className="text-[11px] text-red-600" role="alert">{error}</p>}
    </div>
  );
}
