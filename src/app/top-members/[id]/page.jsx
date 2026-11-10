import MemberProfile from "@/components/demoCompetition/MemberProfile";

// Public demo member profile (SIMULATION ONLY), polled client-side from
// /api/demo-competition/members/[id]; an unknown id renders the friendly not-found state.
export const metadata = {
  title: "Profil membre — Démo / Simulation",
  description: "Profil de démonstration d'un membre du Top Membres. Toutes les valeurs sont simulées.",
};

export default async function Page({ params }) {
  const { id } = await params;
  // key = id: a fresh state (and poller) when navigating from one profile to another.
  return <MemberProfile key={id} id={id} />;
}
