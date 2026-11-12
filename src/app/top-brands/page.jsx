import TopBrandsPage from "@/components/demoCompetition/TopBrandsPage";
import { demoPageMetadata } from "@/lib/demoCompetition/disclosure";

// Public Top Brands leaderboard (simulated data). Data is polled client-side
// from /api/demo-competition/brands; the server only provides the metadata.
// Neutral title + description carrying the central simulation disclosure (src/lib/demoCompetition/disclosure.js).
export const metadata = demoPageMetadata("brands");

export default function Page() {
  return <TopBrandsPage />;
}
