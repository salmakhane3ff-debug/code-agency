import TopBrandsPage from "@/components/demoCompetition/TopBrandsPage";

// Public Demo Competition leaderboard (SIMULATION ONLY). Data is polled client-side
// from /api/demo-competition/brands; the server only provides the metadata.
export const metadata = {
  title: "Top Marques — Démo / Simulation",
  description: "Classement de démonstration des marques sur 30 jours. Toutes les valeurs sont simulées : ni vraies ventes, ni vrais gains.",
};

export default function Page() {
  return <TopBrandsPage />;
}
