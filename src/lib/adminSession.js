/**
 * src/lib/adminSession.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Non-throwing "is this request from an admin?" for routes that are public but
 * must show admins more (e.g. GET /api/products/[id] serves a LOCKED product to
 * the admin edit form only). Same cookie and role rule as withAdminAuth.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { verifyToken } from './services/authService.js';

export function isAdminRequest(req) {
  try {
    const raw = req?.headers?.get?.('cookie') || '';
    const match = raw.match(/(?:^|;\s*)auth_token=([^;]*)/);
    const token = req?.cookies?.get?.('auth_token')?.value || (match ? decodeURIComponent(match[1]) : null);
    if (!token) return false;
    return verifyToken(token)?.role === 'ADMIN';
  } catch {
    return false;
  }
}
