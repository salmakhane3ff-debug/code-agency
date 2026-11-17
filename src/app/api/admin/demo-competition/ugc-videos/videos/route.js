import { withAdminAuth } from "@/lib/middleware/withAdminAuth";
import { adminUgcHandlers } from "@/lib/services/demoCompUgcService";

// Demo Competition — UGC Videos (SIMULATION ONLY) — admin API. Create a demo UGC video. Existing admin authentication (role ADMIN).
export const dynamic = "force-dynamic";
const h = adminUgcHandlers();

export const POST = withAdminAuth(h.createVideo);
