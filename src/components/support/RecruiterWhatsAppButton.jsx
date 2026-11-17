"use client";

/**
 * RecruiterWhatsAppButton — the recruiter mount of the shared DashboardWhatsAppButton.
 * Reads the recruiter app shell's own session (useRecruiterSession().me — set once the shell's
 * GET /api/recruiter/me succeeded; no extra request) and passes it down, so the shared button never
 * imports the recruiter shell (keeps it out of the affiliate dashboard bundle).
 * Mounted once by src/app/recruiter/layout.jsx INSIDE RecruiterAppShell.
 */
import DashboardWhatsAppButton from "@/components/support/DashboardWhatsAppButton";
import { useRecruiterSession } from "@/app/recruiter/_components/RecruiterAppShell";

export default function RecruiterWhatsAppButton() {
  const session = useRecruiterSession();
  return <DashboardWhatsAppButton recruiterSignedIn={!!session?.me} />;
}
