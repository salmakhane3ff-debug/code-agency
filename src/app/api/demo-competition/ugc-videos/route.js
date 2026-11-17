import { publicUgcHandlers } from "@/lib/services/demoCompUgcService";

// Demo Competition — UGC Videos (SIMULATION ONLY) — public, read-only, simulation-labelled leaderboard (short CDN cache).
export const dynamic = "force-dynamic";
const h = publicUgcHandlers();

export const GET = h.leaderboard;
