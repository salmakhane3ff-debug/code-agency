/**
 * src/app/top-brands/layout.jsx — wraps the Top brands list and its profile pages ([id]).
 * Adds the affiliate mobile bottom navigation for signed-in affiliates only (AffiliateNavGate renders
 * nothing on the server and nothing for public visitors) and lets iOS report the safe-area insets on
 * these pages (viewport-fit=cover; the nav and the page padding use env(safe-area-inset-*)).
 * The pages themselves are unchanged.
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
