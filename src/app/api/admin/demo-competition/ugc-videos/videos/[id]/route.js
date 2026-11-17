import { withAdminAuth } from "@/lib/middleware/withAdminAuth";
import { adminUgcHandlers } from "@/lib/services/demoCompUgcService";

// Demo Competition — UGC Videos (SIMULATION ONLY) — admin API. One video: detail / edit. Videos are archived / restored, never deleted (history kept).
export const dynamic = "force-dynamic";
const h = adminUgcHandlers();

export const GET = withAdminAuth(h.getVideo);
export const PATCH = withAdminAuth(h.updateVideo);
