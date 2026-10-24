/**
 * src/lib/demoMiniChatView.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure presentation helpers for the affiliate Mini Chat (Phase 3C-7).
 * The client NEVER computes or formats an earnings amount: earnings text comes
 * pre-rendered by the server from the stored snapshot, and an unavailable
 * snapshot is shown as "unavailable" — no number, no zero. Dates/times are the
 * server's Casablanca `localDate` / `localTime` strings, shown as is (no
 * browser time-zone conversion). Order is the server's order.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const MINI_CHAT_T = Object.freeze({
  ar: {
    title: '💬 الدردشة المصغرة',
    simulated: '🧪 محاكاة',
    disclosure: 'ملفات ومحادثات تجريبية (محاكاة) — ماشي مسوقين حقيقيين. الأرباح المعروضة تجريبية، غير مضمونة وغير حقيقية.',
    loading: 'كيتحمّل…',
    empty: 'مازال ما كاين حتى رسالة. الرسائل كتبان فوقتها.',
    error: 'تعذّر تحميل الدردشة.',
    retry: 'عاود المحاولة',
    unavailable: 'المعطيات ديال هاد الفترة ماشي متوفرة دابا.',
    unavailableBadge: 'غير متوفر',
    provisional: 'مؤقت',
    earningsBadge: 'أرباح تجريبية',
    mediaUnavailable: 'الملف ماشي متوفر.',
    image: 'صورة',
    audio: 'رسالة صوتية',
    today: 'اليوم',
    yesterday: 'البارح',
    truncated: 'كتبان غير آخر الرسائل.',
  },
  fr: {
    title: '💬 Mini Chat',
    simulated: '🧪 Simulation',
    disclosure: 'Profils et conversations simulés (démonstration) — pas de vrais affiliés. Gains démo simulés — non garantis, non réels.',
    loading: 'Chargement…',
    empty: 'Aucun message pour le moment. Les messages apparaissent à leur heure.',
    error: 'Impossible de charger le chat.',
    retry: 'Réessayer',
    unavailable: 'Données indisponibles pour cette période.',
    unavailableBadge: 'Indisponible',
    provisional: 'provisoire',
    earningsBadge: 'Gains démo',
    mediaUnavailable: 'Fichier indisponible.',
    image: 'Image',
    audio: 'Message vocal',
    today: "Aujourd'hui",
    yesterday: 'Hier',
    truncated: 'Seuls les derniers messages sont affichés.',
  },
});

export const miniChatLang = (lang) => (lang === 'fr' ? 'fr' : 'ar');
export const miniChatT = (lang) => MINI_CHAT_T[miniChatLang(lang)];
export const miniChatDir = (lang) => (miniChatLang(lang) === 'ar' ? 'rtl' : 'ltr');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Previous calendar day of a 'YYYY-MM-DD' key (pure calendar arithmetic). */
function prevDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * Label of a Casablanca calendar date. `todayKey` is the server's Casablanca
 * date (derived from the payload's generatedAt by the caller).
 */
export function dayLabel(localDate, todayKey, lang) {
  const t = miniChatT(lang);
  if (!DATE_RE.test(String(localDate || ''))) return '';
  if (todayKey && localDate === todayKey) return t.today;
  if (todayKey && DATE_RE.test(todayKey) && localDate === prevDay(todayKey)) return t.yesterday;
  const [y, m, d] = localDate.split('-').map(Number);
  // Formatted in UTC from the calendar key itself: no browser time-zone shift.
  return new Intl.DateTimeFormat(miniChatLang(lang) === 'ar' ? 'ar-MA' : 'fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Display model of one message — what the UI renders, nothing else.
 * kind: 'text' | 'image' | 'audio' | 'earnings' | 'unknown'
 */
export function messageView(m, lang) {
  const t = miniChatT(lang);
  const base = {
    id: String(m?.id ?? ''),
    profile: m?.profile ?? null,
    time: TIME_RE.test(String(m?.localTime || '')) ? m.localTime : '',
    date: DATE_RE.test(String(m?.localDate || '')) ? m.localDate : '',
  };
  const caption = typeof m?.text === 'string' && m.text.trim() ? m.text : null;
  switch (m?.type) {
    case 'text':
      return { ...base, kind: 'text', text: caption ?? '' };
    case 'image':
    case 'audio': {
      const media = m.media && m.media.kind === m.type && typeof m.media.url === 'string' && m.media.url ? m.media : null;
      return media
        ? { ...base, kind: m.type, media, caption, label: t[m.type] }
        : { ...base, kind: m.type, media: null, caption, label: t[m.type], notice: t.mediaUnavailable };
    }
    case 'earnings': {
      const shown = m.state === 'ok' || m.state === 'provisional';
      // Unavailable: only the fixed sentence — never the server text, never a number.
      return shown && typeof m.text === 'string'
        ? { ...base, kind: 'earnings', available: true, provisional: m.state === 'provisional', text: m.text, badge: t.earningsBadge, metricLabel: m.metricLabel ?? null }
        : { ...base, kind: 'earnings', available: false, provisional: false, text: t.unavailable, badge: t.unavailableBadge, metricLabel: null };
    }
    default:
      return { ...base, kind: 'unknown' };
  }
}

/** Group the (already ordered) messages into Casablanca-day sections. */
export function groupByDay(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const last = out[out.length - 1];
    if (last && last.date === m.localDate) last.items.push(m);
    else out.push({ date: m.localDate, items: [m] });
  }
  return out;
}

/** Response status → UI state. */
export function feedStatus(httpStatus) {
  if (httpStatus === 200) return 'ready';
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) return 'disabled';
  return 'error';
}
