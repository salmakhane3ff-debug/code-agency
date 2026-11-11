import TopMembersPage from "@/components/demoCompetition/TopMembersPage";

// Public Demo Competition leaderboard (SIMULATION ONLY). Data is polled client-side
// from /api/demo-competition/members; the server only provides the metadata.
export const metadata = {
  title: "Top Membres — Démo / Simulation",
  description: "Classement de démonstration des membres sur 30 jours. Toutes les valeurs sont simulées : ni vraies ventes, ni vrais gains.",
};

export default function Page() {
  return <TopMembersPage />;
}
