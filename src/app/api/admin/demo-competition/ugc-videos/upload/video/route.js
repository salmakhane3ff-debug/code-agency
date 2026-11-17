import { withAdminAuth } from "@/lib/middleware/withAdminAuth";
import { adminUgcHandlers } from "@/lib/services/demoCompUgcService";

// Demo Competition — UGC Videos (SIMULATION ONLY) — admin API. Standalone video upload (multipart field "file"); returns the URL to send as videoUrl.
export const dynamic = "force-dynamic";
const h = adminUgcHandlers();

export const POST = withAdminAuth(h.uploadVideo);
