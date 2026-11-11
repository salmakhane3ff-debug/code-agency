"use client";

/**
 * Five-step progress indicator of the "Create Your Own Brand" flow (used by ../BrandTab.jsx):
 *   1 choose the pack · 2 details of the chosen pack · 3 create the brand · 4 review + buy · 5 verification / activation.
 * Numbered circles with an icon and a label; the current step is highlighted (aria-current="step"), completed steps
 * are checked. Read-only (navigation stays on the step's own buttons). Follows the page direction (RTL / LTR) through
 * logical utilities only; the texts come from brandI18n (flow_*).
 */

import { Check, Package, Eye, Crown, ClipboardCheck, ShieldCheck } from "lucide-react";

export const FLOW_STEPS = Object.freeze([
  { key: "flow_pick", Icon: Package },
  { key: "flow_details", Icon: Eye },
  { key: "flow_brand", Icon: Crown },
  { key: "flow_review", Icon: ClipboardCheck },
  { key: "flow_verify", Icon: ShieldCheck },
]);

/** `current`: index of the current step (0 … 4). */
export default function Stepper({ current, t }) {
  const total = FLOW_STEPS.length;
  const now = Math.min(Math.max(current, 0), total - 1);
  return (
    <nav aria-label={t("flow_aria")} data-stepper data-current-step={now + 1}
      className="bg-white rounded-2xl border border-gray-100 shadow-sm px-2 py-3 sm:px-4">
      <p className="sr-only">{t("step_label", { n: now + 1, total })} · {t(FLOW_STEPS[now].key)}</p>
      <ol className="flex items-start">
        {FLOW_STEPS.map(({ key, Icon }, i) => {
          const done = i < now;
          const active = i === now;
          return (
            <li key={key} aria-current={active ? "step" : undefined} data-step-state={done ? "done" : active ? "current" : "todo"}
              className="relative flex-1 min-w-0 flex flex-col items-center text-center">
              {/* connector from the previous circle to this one (logical start side → mirrored in RTL) */}
              {i > 0 && (
                <span aria-hidden="true"
                  className={`absolute top-[18px] -start-1/2 w-full h-0.5 rounded-full ${i <= now ? "bg-violet-600" : "bg-gray-200"}`} />
              )}
              <span aria-hidden="true"
                className={`relative z-10 w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                  done ? "bg-violet-600 text-white"
                    : active ? "bg-violet-600 text-white ring-4 ring-violet-100 shadow-md shadow-violet-200"
                    : "bg-white border-2 border-gray-200 text-gray-400"}`}>
                {done ? <Check className="w-4 h-4" strokeWidth={3} /> : <Icon className="w-4 h-4" />}
                <span className={`absolute -top-1 -end-1 min-w-4 h-4 px-0.5 rounded-full text-[9px] leading-4 font-black ring-2 ring-white ${
                  done || active ? "bg-amber-400 text-violet-950" : "bg-gray-200 text-gray-600"}`}>{i + 1}</span>
              </span>
              <span className={`mt-1.5 px-0.5 text-[10px] sm:text-xs leading-tight font-bold ${active ? "text-violet-700" : done ? "text-gray-700" : "text-gray-400"}`}>
                {t(key)}
                {(done || active) && <span className="sr-only"> ({t(done ? "flow_done" : "flow_current")})</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
