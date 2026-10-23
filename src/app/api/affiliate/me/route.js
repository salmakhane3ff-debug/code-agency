/**
 * GET  /api/affiliate/me  → affiliate profile + balance + stats
 * PUT  /api/affiliate/me  → update bank info
 */

import { withAffiliateAuth }              from '@/lib/middleware/withAffiliateAuth';
import prisma                             from '@/lib/prisma';
import {
  getAffiliateById,
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
import { getIdentityStatus } from '@/lib/services/identityService';
import { getDepositSummary } from '@/lib/services/depositService';
import { getAffiliateDashboardConfig } from '@/lib/services/affiliateDashboardConfigService';

async function getHandler(req, _ctx, decoded) {
  try {
    const affiliate = await getAffiliateById(decoded.affiliateId);
    if (!affiliate) return Response.json({ error: 'Affilié introuvable' }, { status: 404 });

    const [stats, team, bonusConfig, identity, deposit, dashboard] = await Promise.all([
      getAffiliateDashboardStats(decoded.affiliateId),
      getAffiliateTeam(decoded.affiliateId),
      getTeamBonusConfig(),
      // Identity status only (never file keys) — lets the live poll keep the
      // progression + settings card in sync without a separate request.
      getIdentityStatus(decoded.affiliateId),
      // Approved (derived) + pending deposit totals — SEPARATE from Solde
      // disponible, never withdrawable.
      getDepositSummary(decoded.affiliateId),
      // Admin visibility toggles (deposit / booster bars) — display only.
      getAffiliateDashboardConfig(),
    ]);

    const gamification = computeGamification(stats.validReferrals, team.length, affiliate.goalValidReferrals);

    // Enrich each team member with their dynamic commission %
    const tiers = bonusConfig.commissionTiers;
    const teamEnriched = team.map((m) => ({
      ...m,
      commissionPct:   computeMemberCommissionPct(m.deliveredOrdersCount, tiers),
      parentEarnings:  parseFloat(((m.generatedRevenue ?? 0) * computeMemberCommissionPct(m.deliveredOrdersCount, tiers) / 100).toFixed(2)),
    }));

    return Response.json({ affiliate, stats, gamification, team: teamEnriched, bonusConfig, identity, deposit, dashboard });
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
      return Response.json({ affiliate });
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
