/**
 * POST /api/tsajlim3ana/track  { event, source }
 * Lightweight, public, fire-and-forget counter for the recruitment landing.
 * Records WhatsApp-CTA clicks / logins under source="tsajlim3ana" in the
 * recruitment-landing settings row (no PII). Never throws to the client.
 */
import { incrementSettingsCounter } from "@/lib/settingsMerge";
import { rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "whatsapp_cta", "login", "view",
  "hero_whatsapp_click", "header_login_click", "confirmation_section_view",
  "ugc_section_view", "team_section_view", "competition_section_view",
  "video_play", "testimonial_view", "faq_open", "final_whatsapp_click",
  "live_feed_impression", "live_feed_close",
]);

export async function POST(req) {
  const limited = rateLimit(req, "tsajlim_track", { max: 60, windowMs: 60_000 });
  if (limited) return limited;
  try {
    const body = await req.json().catch(() => ({}));
    const event = String(body?.event || "").trim();
    if (body?.source !== "tsajlim3ana" || !ALLOWED.has(event)) {
      return Response.json({ ok: true }); // ignore anything unexpected, silently
    }
    // Atomic in-place +1 on stats[event]: never rewrites the admin's landing
    // config (a read-modify-write here could undo a concurrent admin save).
    await incrementSettingsCounter("recruitment-landing", "stats", event).catch(() => {});
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: true }); // tracking must never surface an error
  }
}
