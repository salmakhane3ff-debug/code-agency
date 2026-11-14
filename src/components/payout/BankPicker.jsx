"use client";
/**
 * BankPicker — visual bank selection (logo + name) for the affiliate dashboard and the
 * recruiter wallet (Phase 4). Pure presentation: the caller passes the selectable banks
 * (selectableBanks(active, current) from src/lib/payoutBanks.js — the active catalogue plus
 * the user's own bank if it was deactivated since) and owns the value. Texts come from the
 * caller (each page has its own FR / AR dictionary).
 *
 * Accessibility: a radiogroup of radio buttons (arrow keys move the choice, like native radios).
 */
import { useRef } from "react";

const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

/**
 * @param {object} p
 * @param {Array<{id,name,logoUrl,isActive,ribRequired}>} p.banks
 * @param {string|null} p.value            selected bank id
 * @param {(bank) => void} p.onChange
 * @param {{ group: string, inactive: string, empty: string, loading?: string }} p.labels
 * @param {boolean} [p.loading]
 * @param {boolean} [p.invalid]            show the error ring
 * @param {string} [p.describedBy]         id of the error / hint text
 * @param {boolean} [p.disabled]
 */
export default function BankPicker({ banks, value, onChange, labels, loading = false, invalid = false, describedBy, disabled = false }) {
  const refs = useRef([]);
  const list = Array.isArray(banks) ? banks : [];

  if (loading) {
    return <p className="text-sm text-gray-500" data-bank-picker-loading>{labels?.loading ?? "…"}</p>;
  }
  if (!list.length) {
    return <p className="text-sm text-gray-500 rounded-xl border border-dashed border-gray-200 px-4 py-3" data-bank-picker-empty>{labels?.empty}</p>;
  }

  const selectedIndex = list.findIndex((b) => b.id === value);
  const focusIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const move = (from, step) => {
    if (disabled) return;
    const next = (from + step + list.length) % list.length;
    onChange?.(list[next]);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={labels?.group}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      className={`grid grid-cols-2 sm:grid-cols-3 gap-2 rounded-xl ${invalid ? "ring-2 ring-red-300 p-1" : ""}`}
      data-bank-picker
    >
      {list.map((b, i) => {
        const selected = b.id === value;
        return (
          <button
            key={b.id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={i === focusIndex ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange?.(b)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(i, 1); }
              else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(i, -1); }
            }}
            className={`relative flex min-w-0 flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:opacity-60 ${
              selected ? "border-gray-900 bg-gray-50 ring-1 ring-gray-900" : "border-gray-200 bg-white hover:border-gray-400"
            }`}
            data-bank-option={b.id}
            data-selected={selected ? "true" : undefined}
            data-inactive={b.isActive === false ? "true" : undefined}
          >
            <span className="flex h-10 w-full items-center justify-center">
              {b.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={b.logoUrl} alt="" className="max-h-10 max-w-full object-contain" loading="lazy" />
              ) : (
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 text-xs font-bold text-gray-600" aria-hidden="true">
                  {initials(b.name)}
                </span>
              )}
            </span>
            <span className="w-full truncate text-xs font-semibold text-gray-800" dir="auto">{b.name}</span>
            {b.isActive === false && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800" data-bank-inactive-badge>
                {labels?.inactive}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
