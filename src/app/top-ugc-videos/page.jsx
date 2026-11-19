import UgcVideosTab from "@/app/affiliate/dashboard/UgcVideosTab";

// Full "UGC Videos" leaderboard of the Demo Competition (simulated data) — the "Voir tout" page of the
// affiliate dashboard home's Top 3 section. Data is polled client-side from /api/demo-competition/ugc-videos
// (the existing board: podium, every ranked video, video player). Same page frame as /top-members.
export const metadata = { title: "Top vidéos UGC", robots: { index: false, follow: false } };

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-3xl overflow-x-clip px-4 pb-12 pt-6 text-start sm:pt-10">
      <UgcVideosTab />
    </main>
  );
}
