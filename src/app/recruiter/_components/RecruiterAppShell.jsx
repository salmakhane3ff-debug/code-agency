"use client";
/**
 * src/app/recruiter/_components/RecruiterAppShell.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2 (UI only): ONE recruiter app. Mounted by src/app/recruiter/layout.jsx around every recruiter
 * route EXCEPT the public ones (isPublicRecruiterPath: /recruiter/login) — those render as before, with
 * no session request and no shell. Because a layout persists across client navigations, the sidebar,
 * header, drawer and bottom bar stay mounted while the recruiter moves between pages (back / forward,
 * direct URLs and refresh all render the same shell).
 *
 * Session data for the CHROME only (name, status, permission-filtered menu, alerts):
 *   GET /api/recruiter/me once per mount (again on a later navigation if it failed), and
 *   GET /api/recruiter/identity on each navigation (a submitted CIN shows up in the alerts at once).
 * Every page still loads and authorizes its OWN data exactly as before (same endpoints, same 401-only
 * login redirect) — the shell never redirects and never blocks a page. The "how rewards work" guide
 * reads GET /api/recruiter/progress on demand (or the summary the dashboard already loaded).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toRecruiterError, toRecruiterIdentityView, toRecruiterProgressSummaryView } from "@/lib/recruiterVisibility";
import { dashboardAlerts, groupProgressDisplay, isPublicRecruiterPath, permsFromMe, sectionForPath } from "../recruiterUiState";
import RecruiterShell from "./RecruiterShell";
import { GuideDialog } from "./DashboardWidgets";

const SessionContext = createContext(null);

/** { me, perms, identity: { status } | null, identityFailed, publishSummary(summary) } — null outside the shell (public routes). */
export function useRecruiterSession() {
  return useContext(SessionContext);
}

/** GET → { ok, status, code, body } (never throws; only the error CODE is kept). */
async function getApi(url) {
  try {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    const body = await res.json().catch(() => null);
    return res.ok ? { ok: true, status: res.status, code: null, body } : { ok: false, status: res.status, code: toRecruiterError(body).code, body: null };
  } catch {
    return { ok: false, status: 0, code: "SERVER_ERROR", body: null };
  }
}

function RecruiterSession({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [perms, setPerms] = useState(null);
  const [identity, setIdentity] = useState({ data: null, failed: false });
  const [summary, setSummary] = useState(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const aliveRef = useRef(true);
  const meRef = useRef(null);

  const loadMe = useCallback(async () => {
    const r = await getApi("/api/recruiter/me");
    if (!aliveRef.current || !r.ok || !r.body?.recruiter) return; // the page itself handles 401 / errors
    meRef.current = r.body.recruiter;
    setMe(r.body.recruiter);
    setPerms(permsFromMe(r.body));
  }, []);

  const loadIdentity = useCallback(async () => {
    const r = await getApi("/api/recruiter/identity");
    if (!aliveRef.current || r.status === 401) return;
    setIdentity(r.ok && r.body?.identity ? { data: toRecruiterIdentityView(r.body.identity), failed: false } : { data: null, failed: true });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // First load, then: retry the session if it failed, refresh the identity alert on every navigation.
  useEffect(() => {
    if (!meRef.current) loadMe();
  }, [pathname, loadMe]);
  useEffect(() => {
    if (me) loadIdentity();
  }, [me, pathname, loadIdentity]);

  const publishSummary = useCallback((s) => { if (s) setSummary(s); }, []);

  const showGuide = useCallback(async () => {
    setGuideOpen(true);
    if (summary) return;
    const r = await getApi("/api/recruiter/progress");
    if (aliveRef.current && r.ok) setSummary(toRecruiterProgressSummaryView(r.body?.progress));
  }, [summary]);
  const closeGuide = useCallback(() => setGuideOpen(false), []);

  const logout = useCallback(async () => {
    setLoggingOut(true);
    try { await fetch("/api/recruiter/auth", { method: "DELETE", credentials: "include", cache: "no-store" }); } catch { /* the cookie expires anyway */ }
    router.replace("/recruiter/login");
  }, [router]);

  const alerts = useMemo(() => dashboardAlerts({ me, perms, identity: identity.data, identityFailed: identity.failed, progress: summary }),
    [me, perms, identity, summary]);
  const value = useMemo(() => ({ me, perms, identity: identity.data, identityFailed: identity.failed, publishSummary }), [me, perms, identity, publishSummary]);
  const groupInfo = useMemo(() => (summary ? groupProgressDisplay(summary) : null), [summary]);

  return (
    <SessionContext.Provider value={value}>
      <RecruiterShell me={me} perms={perms} current={sectionForPath(pathname, perms)} alerts={alerts}
        onLogout={logout} loggingOut={loggingOut} onShowGuide={showGuide}>
        {children}
      </RecruiterShell>
      <GuideDialog open={guideOpen} onClose={closeGuide} summary={summary} groupInfo={groupInfo} />
    </SessionContext.Provider>
  );
}

/** Public recruiter routes render bare; every other recruiter route renders inside the app shell. */
export default function RecruiterAppShell({ children }) {
  const pathname = usePathname();
  if (isPublicRecruiterPath(pathname)) return children;
  return <RecruiterSession>{children}</RecruiterSession>;
}
