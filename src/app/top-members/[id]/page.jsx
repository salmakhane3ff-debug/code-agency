import MemberProfile from "@/components/demoCompetition/MemberProfile";
import { demoPageMetadata } from "@/lib/demoCompetition/disclosure";

// Public member profile (simulated data), polled client-side from
// /api/demo-competition/members/[id]; an unknown id renders the friendly not-found state.
// Neutral title + description carrying the central simulation disclosure (src/lib/demoCompetition/disclosure.js).
export const metadata = demoPageMetadata("member");

export default async function Page({ params }) {
  const { id } = await params;
  // key = id: a fresh state (and poller) when navigating from one profile to another.
  return <MemberProfile key={id} id={id} />;
}
