"use client";

/**
 * Affiliate "💬 Mini Chat" card (Phase 3C-7) — SIMULATED demo conversations.
 *
 * Reads only GET /api/affiliate/demo-chat (polled while the tab is visible).
 * The server decides everything: which demo conversations, which messages
 * (scheduled ≤ now, current cycle), their Casablanca date/time and order, and
 * the earnings text (rendered from the snapshot stored at materialization).
 * This component never sends a profile/assignment id, never re-sorts, never
 * converts times, and never computes or formats an amount — an unavailable
 * earnings message shows the fixed "unavailable" sentence, never a number.
 *
 * Disabled (404 — gates off), 401 or 403 → renders nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "@/context/LanguageContext";
import { miniChatT, miniChatDir, miniChatLang, messageView, groupByDay, dayLabel, feedStatus } from "@/lib/demoMiniChatView";

function authHeaders() {
  const t = (typeof localStorage !== "undefined" && localStorage.getItem("affiliateToken")) || "";
  return { Authorization: `Bearer ${t}` };
}

function ProfileAvatar({ profile }) {
  const [broken, setBroken] = useState(false);
  if (profile?.avatarUrl && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={profile.avatarUrl} alt="" loading="lazy" onError={() => setBroken(true)} className="w-8 h-8 rounded-full object-cover shrink-0" />;
  }
  return (
    <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-black shrink-0" style={{ background: profile?.avatarColor || "#6366f1" }}>
      {(profile?.name || "?").slice(0, 1)}
    </div>
  );
}

function Bubble({ v, t }) {
  if (v.kind === "unknown") return null;
  return (
    <div className="min-w-0 max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-ss-md bg-gray-50 border border-gray-100 px-3 py-2">
      {v.kind === "text" && <p className="text-sm text-gray-800 whitespace-pre-line break-words">{v.text}</p>}

      {v.kind === "image" && (v.media ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img data-mini-chat-image src={v.media.url} alt={v.caption || v.label} loading="lazy"
          width={v.media.width || undefined} height={v.media.height || undefined}
          className="rounded-xl max-h-64 w-auto max-w-full object-contain" />
      ) : <p className="text-xs text-gray-400 italic">{v.notice}</p>)}

      {v.kind === "audio" && (v.media ? (
        <audio data-mini-chat-audio controls preload="none" src={v.media.url} className="w-56 max-w-full" aria-label={v.label}>
          {v.label}
        </audio>
      ) : <p className="text-xs text-gray-400 italic">{v.notice}</p>)}

      {(v.kind === "image" || v.kind === "audio") && v.caption && (
        <p className="text-sm text-gray-800 whitespace-pre-line break-words mt-1.5">{v.caption}</p>
      )}

      {v.kind === "earnings" && (
        <div>
          <span className={`inline-block mb-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${v.available ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-500"}`}>
            {v.badge}{v.provisional ? ` · ${t.provisional}` : ""}
          </span>
          <p data-mini-chat-earnings={v.available ? "available" : "unavailable"}
            className={`text-sm whitespace-pre-line break-words ${v.available ? "text-gray-800" : "text-gray-500 italic"}`}>
            {v.text}
          </p>
        </div>
      )}

      {v.time && <p className="text-[10px] text-gray-400 mt-1 tabular-nums" dir="ltr">{v.time}</p>}
    </div>
  );
}

export default function DemoMiniChat({ pollMs = 60_000, className = "" }) {
  const { lang } = useLanguage();
  const L = miniChatLang(lang);
  const t = miniChatT(L);
  const dir = miniChatDir(L);

  const [state, setState] = useState("loading"); // loading | ready | error | disabled
  const [feed, setFeed] = useState(null);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const inFlight = useRef(false);
  const stopped = useRef(false);
  const listRef = useRef(null);

  const load = useCallback(async () => {
    if (inFlight.current || stopped.current || document.visibilityState === "hidden") return;
    inFlight.current = true;
    try {
      const r = await fetch(`/api/affiliate/demo-chat?lang=${L}`, { cache: "no-store", headers: authHeaders() });
      const next = feedStatus(r.status);
      if (next === "ready") {
        const d = await r.json();
        setFeed(d); setState("ready");
      } else if (next === "disabled") {
        stopped.current = true; setFeed(null); setState("disabled"); // stop polling: nothing to show
      } else {
        setState((s) => (s === "ready" ? s : "error")); // keep the last good feed on a transient error
      }
    } catch {
      setState((s) => (s === "ready" ? s : "error"));
    } finally {
      inFlight.current = false;
    }
  }, [L]);

  useEffect(() => {
    stopped.current = false;
    const skel = setTimeout(() => setShowSkeleton(true), 400); // no flash when the feature is off
    load();
    const timer = setInterval(load, pollMs);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearTimeout(skel); clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [load, pollMs]);

  const count = feed?.messages?.length || 0;
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; // newest at the bottom
  }, [count]);

  if (state === "disabled") return null;
  if (state === "loading" && !showSkeleton) return null;

  const profiles = new Map((feed?.profiles || []).map((p) => [p.key, p]));
  const sections = groupByDay(feed?.messages || []);

  return (
    <section dir={dir} data-mini-chat className={`rounded-3xl bg-white border border-gray-100 shadow-lg shadow-gray-100/70 p-4 sm:p-6 ${className}`}>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <h2 className="text-base sm:text-lg font-black text-gray-900">{t.title}</h2>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-black">{t.simulated}</span>
      </div>

      {/* Permanent simulation disclosure — independent of the payload. */}
      <p data-mini-chat-disclosure className="text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2 mb-3">
        ⚠️ {t.disclosure}
      </p>

      {state === "loading" && (
        <div className="space-y-2.5 py-2" aria-busy="true" aria-label={t.loading}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-start gap-2 animate-pulse">
              <div className="w-8 h-8 rounded-full bg-gray-100" />
              <div className="h-10 rounded-2xl bg-gray-100 flex-1 max-w-[70%]" />
            </div>
          ))}
        </div>
      )}

      {state === "error" && (
        <div className="text-center py-6">
          <p className="text-sm text-gray-500 mb-2">{t.error}</p>
          <button type="button" onClick={() => { setState("loading"); load(); }}
            className="text-xs font-bold text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-xl px-3 py-1.5">
            {t.retry}
          </button>
        </div>
      )}

      {state === "ready" && count === 0 && <p className="text-center text-sm text-gray-400 py-6">{t.empty}</p>}

      {state === "ready" && count > 0 && (
        <div ref={listRef} className="max-h-[26rem] overflow-y-auto overscroll-contain space-y-3 pe-1">
          {feed.truncated && <p className="text-center text-[11px] text-gray-400">{t.truncated}</p>}
          {sections.map((s) => (
            <div key={s.date} className="space-y-2.5">
              <div className="flex justify-center">
                <span className="px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-500 text-[10px] font-bold">{dayLabel(s.date, feed.today, L)}</span>
              </div>
              {s.items.map((m) => {
                const v = messageView(m, L);
                if (v.kind === "unknown") return null;
                const p = profiles.get(v.profile);
                return (
                  <div key={v.id} className="flex items-start gap-2">
                    <ProfileAvatar profile={p} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-bold text-gray-600 mb-0.5 truncate">{p?.name || "—"}</p>
                      <Bubble v={v} t={t} />
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
