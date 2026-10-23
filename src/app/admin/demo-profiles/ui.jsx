"use client";

/** Shared bits of the DEMO profile admin pages (fake personas, not real affiliates). */
import { useState } from "react";

export function DemoBadge() {
  return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-50 text-amber-700 border border-amber-200">DÉMO</span>;
}

export function DemoAvatar({ p, size = 36 }) {
  const [broken, setBroken] = useState(false);
  if (p.avatarUrl && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={p.avatarUrl} alt="" onError={() => setBroken(true)} className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />;
  }
  return (
    <div className="rounded-full flex items-center justify-center text-white text-sm font-black shrink-0" style={{ width: size, height: size, background: p.avatarColor || "#6366f1" }}>
      {(p.name || "?").slice(0, 1)}
    </div>
  );
}
