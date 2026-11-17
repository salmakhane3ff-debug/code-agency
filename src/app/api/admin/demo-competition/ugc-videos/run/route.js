import { withAdminAuth } from "@/lib/middleware/withAdminAuth";
import { adminUgcHandlers } from "@/lib/services/demoCompUgcService";

// Demo Competition — UGC Videos (SIMULATION ONLY) — admin API. Run the UGC engine now (409 UGC_DISABLED while the module is OFF).
export const dynamic = "force-dynamic";
const h = adminUgcHandlers();

export const POST = withAdminAuth(h.run);
