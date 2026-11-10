"use client";
/**
 * src/app/recruiter/_components/DashboardWidgets.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The "كيف تعمل المكافآت" guide (opened from "المزيد" → مساعدة): the rules of the system with the CURRENT
 * settings from GET /api/recruiter/progress (thresholds, group size, switches) — nothing invented.
 * Simplified dashboard: the former dashboard cards (hero, reward cards, charts) are gone; the dashboard is
 * src/app/recruiter/page.jsx (six KPI cards).
 * Texts in the market language (RECRUITER_TEXT, guide_*); the "follow" arrow points to the end side.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useRef } from "react";
import Link from "next/link";
import { CheckCircle2, Crown, X } from "lucide-react";
import { useModal } from "./RecruiterShell";
import { ForwardArrow, useRecruiterLocale } from "./ui";

/**
 * "كيف تعمل المكافآت" — the rules of the system, with the CURRENT settings from GET /api/recruiter/progress
 * (thresholds, group size, switches). Escape / backdrop / close button close it.
 */
export function GuideDialog({ open, onClose, summary, groupInfo }) {
  const { t, dir } = useRecruiterLocale();
  const panelRef = useRef(null);
  useModal(open, onClose, panelRef);
  if (!open) return null;
  const threshold = summary?.individualThreshold;
  const rules = [
    summary?.individualEnabled ? t("guide_individual_on", { n: threshold ?? "—" }) : t("guide_individual_off"),
    groupInfo?.enabled
      ? t("guide_group_on", { size: groupInfo.size ?? "—", n: groupInfo.threshold ?? "—" })
      : t("guide_group_off"),
    t("guide_rule_real_only"),
    t("guide_rule_reversal"),
    t("guide_rule_network"),
    t("guide_rule_kyc_bank"),
  ];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-labelledby="guide-title" data-guide>
      <button type="button" className="absolute inset-0 bg-black/40" aria-label={t("common_close")} onClick={onClose} tabIndex={-1} />
      <div ref={panelRef} className="relative w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl bg-white shadow-2xl p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <h2 id="guide-title" className="text-base font-bold text-gray-900 flex items-center gap-2">
            <Crown className="w-6 h-6 text-amber-500" fill="currentColor" aria-hidden="true" /> {t("guide_title")}
          </h2>
          <button type="button" onClick={onClose} aria-label={t("common_close")} className="grid place-items-center w-9 h-9 rounded-xl text-gray-500 hover:bg-gray-100">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        <ul className="mt-4 space-y-3">
          {rules.map((r) => (
            <li key={r} className="flex items-start gap-2 text-sm text-gray-700 leading-relaxed">
              <CheckCircle2 className="w-5 h-5 text-violet-500 shrink-0 mt-0.5" aria-hidden="true" /><span>{r}</span>
            </li>
          ))}
        </ul>
        <Link href="/recruiter/affiliates" onClick={onClose} className="mt-5 inline-flex items-center gap-1.5 min-h-11 rounded-xl bg-violet-600 px-4 text-sm font-bold text-white hover:bg-violet-700">
          {t("guide_follow")} <ForwardArrow dir={dir} className="w-4 h-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
