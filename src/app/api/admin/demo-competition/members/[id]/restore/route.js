import { withAdminAuth } from "@/lib/middleware/withAdminAuth";
import { adminDemoCompHandlers } from "@/lib/demoCompetition/routeHandlers";

// Demo Competition (SIMULATION ONLY) — admin API. Profiles are archived / restored, never deleted (history kept).
export const dynamic = "force-dynamic";
const h = adminDemoCompHandlers();

export const POST = withAdminAuth(h.restoreMember);
