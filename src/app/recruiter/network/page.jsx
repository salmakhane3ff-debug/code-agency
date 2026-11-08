"use client";
/**
 * /recruiter/network — the former network tree URL. The tree is now part of the Affiliates section
 * (/recruiter/affiliates): this page only forwards there, client-side (router.replace: no history entry),
 * mapping `?root=X` (a sub-network) to `?id=X` (that affiliate's details and its network). No data is read
 * here; the target page checks the session and refuses ids outside the recruiter's network (404).
 */
import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toRecruiterNetworkPathView } from "@/lib/recruiterVisibility";
import { LoadingBlock } from "../_components/ui";

/** The affiliates URL for an old `?root=` value (only a non-empty string id is kept). */
function targetFor(root) {
  const id = toRecruiterNetworkPathView({ id: root }).id;
  return id ? `/recruiter/affiliates?id=${encodeURIComponent(id)}` : "/recruiter/affiliates";
}

function RedirectToAffiliates() {
  const router = useRouter();
  const root = useSearchParams().get("root");
  useEffect(() => {
    router.replace(targetFor(root));
  }, [router, root]);
  return <LoadingBlock />;
}

export default function RecruiterNetworkPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <RedirectToAffiliates />
    </Suspense>
  );
}
