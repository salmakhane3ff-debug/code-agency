import { withAdminAuth } from "@/lib/middleware/withAdminAuth";
import { adminDemoCompHandlers } from "@/lib/demoCompetition/routeHandlers";

// Demo Competition (SIMULATION ONLY) — admin API. Existing admin authentication (role ADMIN).
export const dynamic = "force-dynamic";
const h = adminDemoCompHandlers();

export const GET = withAdminAuth(h.getMember);
export const PATCH = withAdminAuth(h.updateMember);
