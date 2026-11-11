import BrandProfile from "@/components/demoCompetition/BrandProfile";

// Public demo brand profile (SIMULATION ONLY), polled client-side from
// /api/demo-competition/brands/[id]; an unknown id renders the friendly not-found state.
export const metadata = {
  title: "Profil marque — Démo / Simulation",
  description: "Profil de démonstration d'une marque du Top Marques. Toutes les valeurs sont simulées.",
};

export default async function Page({ params }) {
  const { id } = await params;
  // key = id: a fresh state (and poller) when navigating from one profile to another.
  return <BrandProfile key={id} id={id} />;
}
