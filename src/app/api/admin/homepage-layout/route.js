import { withAdminAuth } from "@/lib/middleware/withAdminAuth";
import { homepageLayoutHandlers } from "@/lib/services/homepageLayoutService";

// Homepage layout — conflict-safe admin read / write (revision check). Used by the Homepage Builder and by
// Demo Competition → Homepage Settings. The public homepage keeps reading GET /api/setting?type=homepage_layout.
export const dynamic = "force-dynamic";
const h = homepageLayoutHandlers();

export const GET = withAdminAuth(h.get);
export const PUT = withAdminAuth(h.put);
