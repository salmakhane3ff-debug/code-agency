import { withAdminAuth } from "@/lib/middleware/withAdminAuth";
import { adminUgcHandlers } from "@/lib/services/demoCompUgcService";

// Demo Competition — UGC Videos (SIMULATION ONLY) — admin API. Module state (settings + videos) and module settings. Existing admin authentication (role ADMIN).
export const dynamic = "force-dynamic";
const h = adminUgcHandlers();

export const GET = withAdminAuth(h.getState);
export const PATCH = withAdminAuth(h.updateSettings);
