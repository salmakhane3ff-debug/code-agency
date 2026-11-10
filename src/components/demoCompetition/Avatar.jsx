"use client";
/**
 * Circular image (member photo / brand product image) with an initials fallback
 * on a deterministic colour — never a generic logo. Falls back too when the
 * image fails to load.
 */
import { useState } from "react";
import { hueOf, initials } from "@/lib/demoCompetition/i18n";

export default function Avatar({ src, name, id, alt, size = 44, ring = "" }) {
  const [failedSrc, setFailedSrc] = useState(null);
  const showImage = !!src && failedSrc !== src;
  const style = { width: size, height: size };
  if (showImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt || ""}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailedSrc(src)}
        className={`shrink-0 rounded-full object-cover bg-gray-100 ${ring}`}
        style={style}
      />
    );
  }
  const hue = hueOf(id ?? name);
  return (
    <span
      role="img"
      aria-label={alt || name || ""}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ${ring}`}
      style={{ ...style, fontSize: Math.max(10, Math.round(size * 0.38)), background: `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 40) % 360} 75% 35%))` }}
    >
      {initials(name)}
    </span>
  );
}
