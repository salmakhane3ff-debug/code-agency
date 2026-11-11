import { publicDemoCompHandlers } from "@/lib/demoCompetition/routeHandlers";

// Demo Competition (SIMULATION ONLY) — public, read-only, simulation-labelled data (short CDN cache).
export const dynamic = "force-dynamic";
const h = publicDemoCompHandlers();

export const GET = h.brand;
