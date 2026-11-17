import { withAdminAuth } from "@/lib/middleware/withAdminAuth";
import { adminUgcHandlers } from "@/lib/services/demoCompUgcService";

// Demo Competition — UGC Videos (SIMULATION ONLY) — admin API. Create deterministic placeholder videos up to the target count (idempotent).
export const dynamic = "force-dynamic";
const h = adminUgcHandlers();

export const POST = withAdminAuth(h.generate);
