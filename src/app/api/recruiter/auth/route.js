/**
 * /api/recruiter/auth
 * POST   { username, password } → recruiter login: sets the HttpOnly cookie recruiter_token
 * DELETE                       → logout: clears the cookie
 * Responses use recruiterVisibility projections only (profile view, error codes).
 */
import { recruiterHandlers } from '@/lib/recruiterRouteHandlers';
import { toRecruiterError } from '@/lib/recruiterVisibility';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Errors leave this route only through the recruiterVisibility error projection ({ code }).
const h = recruiterHandlers({ toRecruiterError });
export const POST = h.login;
export const DELETE = h.logout;
