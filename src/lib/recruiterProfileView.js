/**
 * src/lib/recruiterProfileView.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — the recruiter's OWN account as shown on their
 * dashboard (PURE allowlist projection, Phase 2). Kept apart from
 * recruiterVisibility.js, whose reward projections never read any isActive flag:
 * this one reads the RECRUITER's own account status (recruiters.isActive), never
 * an affiliate's.
 * ─────────────────────────────────────────────────────────────────────────────
 */
/**
 * The recruiter's own account, as shown on their dashboard: identity, status and dates —
 * never the password hash, the admin who created or disabled them, or permission flags.
 */
export function toRecruiterProfileView(row) {
  const iso = (d) => {
    const t = d ? new Date(d) : null;
    return t && Number.isFinite(t.getTime()) ? t.toISOString() : null;
  };
  return {
    username: typeof row?.username === 'string' ? row.username : null,
    name: typeof row?.name === 'string' ? row.name : null,
    phone: typeof row?.phone === 'string' ? row.phone : null,
    status: row?.isActive === true ? 'ACTIVE' : 'DISABLED',
    createdAt: iso(row?.createdAt),
    lastLoginAt: iso(row?.lastLoginAt),
  };
}

/**
 * The recruiter's OWN permissions (Phase 6 part 4), set by an admin and re-read on every request:
 * exactly { canViewOrders, canCreateAffiliates } (strict booleans). The server enforces them; the
 * dashboard only uses them to hide what the recruiter cannot do.
 */
export function toRecruiterPermissionsView(row) {
  return { canViewOrders: row?.canViewOrders === true, canCreateAffiliates: row?.canCreateAffiliates === true };
}
