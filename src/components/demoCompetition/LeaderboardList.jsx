"use client";
/**
 * Animated leaderboard list: framer-motion `layout` animations reorder the rows
 * smoothly when ranks change between two polls (rows keyed by profile id).
 * MotionConfig reducedMotion="user" → no movement animation for visitors who
 * prefer reduced motion. The #1 row gets room for its crown (flameSpaceClass).
 * Responsive by CONTAINER width (not the viewport): a narrow list (phones, each column
 * of the desktop block) is one column of cards; a wide list (≥ 42rem, e.g. 768 px) shows
 * the leader featured across the full width and the others in two columns. Each row is a
 * container too, so each card picks its own layout from its own width (see LeaderCard).
 */
import { MotionConfig, motion } from "framer-motion";
import { flameSpaceClass } from "./flame";
import "./demoCompetition.css";

export default function LeaderboardList({ items, renderItem, label }) {
  return (
    <MotionConfig reducedMotion="user">
      {/* The wrapper is the container the list's own columns respond to (an element cannot query itself). */}
      <div className="@container">
        <ol className="grid grid-cols-1 gap-3 @2xl:grid-cols-2" aria-label={label}>
          {items.map((item) => (
            <motion.li
              key={item.id}
              layout="position"
              initial={false}
              transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.9 }}
              className={`@container list-none ${flameSpaceClass(item.rank)} @2xl:first:col-span-2`}
            >
              {renderItem(item)}
            </motion.li>
          ))}
        </ol>
      </div>
    </MotionConfig>
  );
}

/** Placeholder rows while the first response is loading. */
export function LeaderboardSkeleton({ rows = 5, label }) {
  return (
    <ol className="flex flex-col gap-3" aria-label={label} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="list-none rounded-2xl border border-gray-100 bg-white p-3 shadow-sm">
          <div className="flex items-center gap-3 motion-safe:animate-pulse">
            <span className="h-9 w-9 rounded-full bg-gray-200" />
            <span className="h-14 w-14 rounded-full bg-gray-200" />
            <span className="h-4 flex-1 rounded bg-gray-200" />
          </div>
        </li>
      ))}
    </ol>
  );
}
