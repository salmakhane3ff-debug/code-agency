/**
 * GET  /api/affiliate/me  → affiliate profile + balance + stats
 * PUT  /api/affiliate/me  → update bank info
 */

import { withAffiliateAuth }              from '@/lib/middleware/withAffiliateAuth';
import prisma                             from '@/lib/prisma';
import {
  getAffiliateById,
  affiliateSessionToken,
  updateAffiliateBank,
  updateAffiliateProfile,
  loginAffiliate as _loginAffiliate,
  getAffiliateDashboardStats,
  computeGamification,
  getAffiliateTeam,
  getTeamBonusConfig,
  computeMemberCommissionPct,
} from '@/lib/services/affiliateSystemService';
import { comparePassword } from '@/lib/services/authService';
import { trustedRateLimit } from '@/lib/trustedProxy';

// Phase 6 part 2: the existing affiliate password policy (6 characters, as the dashboard
// already requires), now enforced by the server too.
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;
const AFFILIATE_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
import { getIdentityStatus } from '@/lib/services/identityService';
import { getDepositSummary } from '@/lib/services/depositService';

async function getHandler(req, _ctx, decoded) {
  try {
    const affiliate = await getAffiliateById(decoded.affiliateId);
    if (!affiliate) return Response.json({ error: 'Affilié introuvable' }, { status: 404 });

    const [stats, team, bonusConfig, identity, deposit] = await Promise.all([
      getAffiliateDashboardStats(decoded.affiliateId),
      getAffiliateTeam(decoded.affiliateId),
      getTeamBonusConfig(),
      // Identity status only (never file keys) — lets the live poll keep the
      // progression + settings card in sync without a separate request.
      getIdentityStatus(decoded.affiliateId),
      // Approved (derived) + pending deposit totals — SEPARATE from Solde
      // disponible, never withdrawable.
      getDepositSummary(decoded.affiliateId),
    ]);

    const gamification = computeGamification(stats.validReferrals, team.length, affiliate.goalValidReferrals);

    // Enrich each team member with their dynamic commission %
    const tiers = bonusConfig.commissionTiers;
    const teamEnriched = team.map((m) => ({
      ...m,
      commissionPct:   computeMemberCommissionPct(m.deliveredOrdersCount, tiers),
      parentEarnings:  parseFloat(((m.generatedRevenue ?? 0) * computeMemberCommissionPct(m.deliveredOrdersCount, tiers) / 100).toFixed(2)),
    }));

    return Response.json({ affiliate, stats, gamification, team: teamEnriched, bonusConfig, identity, deposit });
  } catch (err) {
    console.error('Affiliate me GET error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}

async function putHandler(req, _ctx, decoded) {
  try {
    const body = await req.json();
    const { type } = body;

    // ── Profile + password update ──────────────────────────────────────────
    if (type === 'profile') {
      const { name, phone, currentPassword, newPassword } = body;

      // If changing password, verify current password first
      if (newPassword) {
        if (trustedRateLimit(req, `affiliate-password:${decoded.affiliateId}`, { max: 5, windowMs: 15 * 60_000 })) {
          return Response.json({ error: 'Trop de tentatives. Réessayez plus tard.' }, { status: 429 });
        }
        if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
          return Response.json({ error: `Le mot de passe doit contenir entre ${PASSWORD_MIN} et ${PASSWORD_MAX} caractères` }, { status: 400 });
        }
        if (!currentPassword) {
          return Response.json({ error: 'Mot de passe actuel requis' }, { status: 400 });
        }
        const raw = await prisma.affiliate.findUnique({
          where: { id: decoded.affiliateId },
          select: { password: true },
        });
        const valid = await comparePassword(currentPassword, raw?.password || '');
        if (!valid) {
          return Response.json({ error: 'Mot de passe actuel incorrect' }, { status: 400 });
        }
      }

      const affiliate = await updateAffiliateProfile(decoded.affiliateId, {
        name,
        phone: phone || undefined,
        password: newPassword || undefined,
      });
      if (!newPassword) return Response.json({ affiliate });
      // Phase 6 part 2: the password change revoked every session (tokenVersion +1); the
      // caller keeps working with a fresh token for the new version (cookie + body, the
      // dashboard stores the body token like the login does).
      const fresh = await prisma.affiliate.findUnique({ where: { id: decoded.affiliateId }, select: { id: true, username: true, tokenVersion: true } });
      const token = affiliateSessionToken(fresh);
      const res = Response.json({ affiliate, token });
      res.headers.set('Set-Cookie', `affiliate_token=${token}; HttpOnly; Path=/api/affiliate; Max-Age=${AFFILIATE_COOKIE_MAX_AGE}; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
      return res;
    }

    // ── Bank update (default) ──────────────────────────────────────────────
    const { bankName, rib, accountName } = body;
    const affiliate = await updateAffiliateBank(decoded.affiliateId, { bankName, rib, accountName });
    return Response.json({ affiliate });

  } catch (err) {
    console.error('Affiliate me PUT error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}

export const GET = withAffiliateAuth(getHandler);
export const PUT = withAffiliateAuth(putHandler);
