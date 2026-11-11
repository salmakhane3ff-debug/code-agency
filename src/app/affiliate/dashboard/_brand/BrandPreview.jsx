"use client";

/**
 * Automatic brand preview (step 3 of the flow, used by ../BrandTab.jsx): the default visual mark — the first letter
 * of the typed name in a circle, like the brand header shown once the request exists — with the typed name and the
 * chosen pack. Updates live while the name is typed. Nothing is uploaded: there is no logo or image field.
 */

import { Crown, Sparkles } from "lucide-react";

export default function BrandPreview({ name, packName, t }) {
  const clean = (name || "").replace(/\s+/g, " ").trim();
  const letter = clean ? Array.from(clean)[0].toLocaleUpperCase() : "";
  return (
    <section aria-label={t("preview_title")} data-brand-preview
      className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-violet-700 via-violet-600 to-fuchsia-500 text-white p-4 shadow-md shadow-violet-200">
      <div aria-hidden="true" className="absolute -top-8 -end-8 w-28 h-28 rounded-full bg-white/10" />
      <p className="relative inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/15 text-[11px] font-bold">
        <Sparkles className="w-3 h-3" aria-hidden="true" />{t("preview_title")}
      </p>
      <div className="relative flex items-center gap-3 mt-3">
        <div className="w-16 h-16 rounded-full bg-gray-950 ring-2 ring-amber-400/70 flex items-center justify-center shrink-0" aria-hidden="true" data-preview-mark>
          {letter ? <span className="text-3xl font-black text-amber-400 font-serif leading-none">{letter}</span> : <Crown className="w-7 h-7 text-amber-400" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className={`text-xl font-black leading-tight ${clean ? "text-white" : "text-white/60"}`}>
            <bdi dir="auto" className="inline-block max-w-full truncate align-top" data-preview-name>{clean || t("hero_label")}</bdi>
          </p>
          {packName && <p className="text-xs text-violet-100 mt-0.5"><bdi dir="auto" className="inline-block max-w-full truncate align-top">{packName}</bdi></p>}
        </div>
      </div>
      <p className="relative text-[11px] text-violet-50/90 mt-3">{t("preview_auto")}</p>
    </section>
  );
}
