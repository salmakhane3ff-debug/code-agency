/**
 * src/app/top-ugc-videos/layout.jsx — wraps the full UGC Videos leaderboard (the "Voir tout" page of the
 * affiliate dashboard's Top UGC Videos section), exactly like the Top members / Top brands layouts: the
 * affiliate mobile bottom navigation for signed-in affiliates only (AffiliateNavGate renders nothing on
 * the server and nothing for public visitors) and viewport-fit=cover for the safe-area insets.
 */
import AffiliateNavGate from "@/components/affiliate/AffiliateNavGate";

export const viewport = { viewportFit: "cover" };

export default function Layout({ children }) {
  return (
    <>
      {children}
      <AffiliateNavGate />
    </>
  );
}
