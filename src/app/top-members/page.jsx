import TopMembersPage from "@/components/demoCompetition/TopMembersPage";
import { demoPageMetadata } from "@/lib/demoCompetition/disclosure";

// Public Top Members leaderboard (simulated data). Data is polled client-side
// from /api/demo-competition/members; the server only provides the metadata.
// Neutral title + description carrying the central simulation disclosure (src/lib/demoCompetition/disclosure.js).
export const metadata = demoPageMetadata("members");

export default function Page() {
  return <TopMembersPage />;
}
