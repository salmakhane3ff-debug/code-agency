/**
 * src/lib/serverText/liveText.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Display-time localization of the LIVE texts the server writes in Darija:
 *   • GET /api/live-activity       → src/lib/services/liveActivityEngine.js
 *       buildEvent() activity / detail / default name, relTime() "قبل N ث|د|س",
 *       cities picked from MOROCCAN_CITIES (src/lib/recruitmentLiveData.js)
 *   • GET /api/tsajlim3ana/live-feed → formatLiveFeedEvent() (src/lib/recruitmentCta.js)
 *
 * Pure (no React / DOM / I/O). The server keeps writing exactly what it writes
 * today; this module only RECOGNISES those fixed code templates (exact string or
 * anchored regex) and re-renders them for the visitor's market:
 *   'ar' (MA) → returned unchanged, byte for byte (what the server sends)
 *   'fr' (FR) → French
 * Anything not recognised — person names, admin-configured cities, any future or
 * free text — is returned UNCHANGED. scripts/liveText.test.mjs proves every
 * template round-trips against the real server functions.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const isFr = (lang) => lang === 'fr';

// ── Live Activity: buildEvent() literals (liveActivityEngine.js) ──────────────
// Arabic = the exact literal the engine writes; French = display text.
export const LIVE_ACTIVITY_TEXT_FR = Object.freeze({
  'تم تسليم طلب': 'Commande livrée',                              // delivered
  'عمولة جديدة': 'Nouvelle commission',                           // commission
  'طلب جديد': 'Nouvelle commande',                                // newOrder
  'انضمت للمنصة': 'A rejoint la plateforme',                      // newAffiliate
  'وصلت': 'A atteint',                                            // booster milestone ("a / b" detail)
  'Starter Booster': 'Starter Booster',                           // booster sales (product name, same in both markets)
  'دخلات المنافسة ديال هاد الشهر': 'A rejoint la compétition du mois', // competition
});

/** Name the engine writes when no demo person is available. */
export const LIVE_DEFAULT_NAME = 'مسوقة';
export const LIVE_DEFAULT_NAME_FR = 'Affiliée';

/** buildEvent() activity sentence → market language (unknown text unchanged). */
export function localizeLiveActivityText(text, lang) {
  if (!isFr(lang) || typeof text !== 'string') return text;
  return Object.prototype.hasOwnProperty.call(LIVE_ACTIVITY_TEXT_FR, text) ? LIVE_ACTIVITY_TEXT_FR[text] : text;
}

// Booster sales detail: `+${n} ${n === 1 ? 'مبيعة' : 'مبيعات'}`. The milestone
// detail "a / b" is digits only and passes through unchanged.
const BOOSTER_SALES_RE = /^\+(\d+) (مبيعة|مبيعات)$/;
export function localizeBoosterDetail(text, lang) {
  if (!isFr(lang) || typeof text !== 'string') return text;
  const m = BOOSTER_SALES_RE.exec(text);
  if (!m) return text;
  return `+${m[1]} ${Number(m[1]) === 1 ? 'vente' : 'ventes'}`;
}

/** The engine's generic name (only for an event without a demo person). */
export function localizeLiveName(name, personId, lang) {
  if (!isFr(lang) || personId || name !== LIVE_DEFAULT_NAME) return name;
  return LIVE_DEFAULT_NAME_FR;
}

// relTime(): `قبل ${n} ث` (seconds) | `قبل ${n} د` (minutes) | `قبل ${n} س` (hours).
const REL_TIME_RE = /^قبل (\d+) (ث|د|س)$/;
const REL_UNIT_FR = Object.freeze({ 'ث': 's', 'د': 'min', 'س': 'h' });
export function localizeRelTime(text, lang) {
  if (!isFr(lang) || typeof text !== 'string') return text;
  const m = REL_TIME_RE.exec(text);
  return m ? `il y a ${m[1]} ${REL_UNIT_FR[m[2]]}` : text;
}

// ── Cities: every MOROCCAN_CITIES entry → French / Latin spelling ─────────────
// Admin-configured cities outside this list are shown unchanged.
export const CITY_FR = Object.freeze({
  'الدار البيضاء': 'Casablanca', 'الرباط': 'Rabat', 'مراكش': 'Marrakech', 'فاس': 'Fès', 'طنجة': 'Tanger',
  'أكادير': 'Agadir', 'مكناس': 'Meknès', 'وجدة': 'Oujda', 'القنيطرة': 'Kénitra', 'تطوان': 'Tétouan',
  'آسفي': 'Safi', 'المحمدية': 'Mohammédia', 'خريبكة': 'Khouribga', 'الجديدة': 'El Jadida', 'بني ملال': 'Béni Mellal',
  'تازة': 'Taza', 'الناظور': 'Nador', 'سطات': 'Settat', 'برشيد': 'Berrechid', 'خميسات': 'Khémisset',
  'العرائش': 'Larache', 'الفقيه بن صالح': 'Fquih Ben Salah', 'تارودانت': 'Taroudant', 'وزان': 'Ouezzane', 'سيدي قاسم': 'Sidi Kacem',
  'سيدي سليمان': 'Sidi Slimane', 'بركان': 'Berkane', 'تاوريرت': 'Taourirt', 'جرسيف': 'Guercif', 'الحسيمة': 'Al Hoceïma',
  'الرشيدية': 'Errachidia', 'تنغير': 'Tinghir', 'ورزازات': 'Ouarzazate', 'زاكورة': 'Zagora', 'طاطا': 'Tata',
  'كلميم': 'Guelmim', 'طانطان': 'Tan-Tan', 'العيون': 'Laâyoune', 'الداخلة': 'Dakhla', 'بوجدور': 'Boujdour',
  'السمارة': 'Smara', 'أزيلال': 'Azilal', 'الصويرة': 'Essaouira', 'شفشاون': 'Chefchaouen', 'ميدلت': 'Midelt',
  'صفرو': 'Sefrou', 'بنسليمان': 'Benslimane', 'سيدي بنور': 'Sidi Bennour', 'اليوسفية': 'Youssoufia', 'الفنيدق': 'Fnideq',
  'مرتيل': 'Martil', 'المضيق': "M'diq", 'القصر الكبير': 'Ksar El Kébir', 'أصيلة': 'Asilah', 'إمزورن': 'Imzouren',
  'بني أنصار': 'Béni Ansar', 'زايو': 'Zaïo', 'الدروة': 'Deroua', 'ابن أحمد': 'Ben Ahmed', 'دار بوعزة': 'Dar Bouazza',
  'بوسكورة': 'Bouskoura', 'النواصر': 'Nouaceur', 'تمارة': 'Témara', 'الصخيرات': 'Skhirat', 'سلا': 'Salé',
  'تيفلت': 'Tiflet', 'الرماني': 'Rommani', 'مولاي إدريس زرهون': 'Moulay Idriss Zerhoun', 'الحاجب': 'El Hajeb', 'أزرو': 'Azrou',
  'إفران': 'Ifrane', 'تيمحضيت': 'Timahdite', 'كلعة السراغنة': 'El Kelâa des Sraghna', 'ابن جرير': 'Ben Guerir', 'الكارة': 'El Gara',
  'سيدي رحال': 'Sidi Rahal', 'تحناوت': 'Tahannaout', 'أمزميز': 'Amizmiz', 'شيشاوة': 'Chichaoua', 'إمنتانوت': 'Imintanoute',
  'سيدي إسماعيل': 'Sidi Smaïl', 'أزمور': 'Azemmour', 'بئر الجديد': 'Bir Jdid', 'تيط مليل': 'Tit Mellil', 'مديونة': 'Médiouna',
  'تارجيست': 'Targuist', 'بني بوعياش': 'Béni Bouayach', 'كتامة': 'Ketama', 'وادي لاو': 'Oued Laou', 'الجبهة': 'El Jebha',
  'بني حذيفة': 'Béni Hadifa', 'ميضار': 'Midar', 'الدريوش': 'Driouch', 'بن الطيب': 'Ben Taïeb', 'أكدز': 'Agdz',
  'بوعرفة': 'Bouarfa', 'فجيج': 'Figuig', 'السعيدية': 'Saïdia', 'تندرارة': 'Tendrara', 'بني تجيت': 'Béni Tadjit',
  'قصبة تادلة': 'Kasba Tadla', 'زاوية الشيخ': 'Zaouiat Cheikh', 'أفورار': 'Afourar', 'دمنات': 'Demnate', 'أيت أورير': 'Aït Ourir',
  'الريصاني': 'Rissani', 'أرفود': 'Erfoud', 'بوذنيب': 'Boudnib', 'تالسينت': 'Talsint', 'بومالن دادس': 'Boumalne Dadès',
  'تينجداد': 'Tinejdad', 'كلميمة': 'Goulmima', 'بولمان': 'Boulemane', 'أوطاط الحاج': 'Outat El Haj', 'مسور': 'Missour',
  'جماعة الوداي': 'Jemâa El Oudaya', 'سيدي علال البحراوي': 'Sidi Allal El Bahraoui', 'الغزوانية': 'El Ghazouania',
  'عين عتيق': 'Aïn Attig', 'عين حرودة': 'Aïn Harrouda', 'بوزنيقة': 'Bouznika', 'الهرهورة': 'Harhoura', 'سيدي يحيى الغرب': 'Sidi Yahya El Gharb',
  'مشرع بلقصيري': 'Mechra Bel Ksiri', 'سيدي علال التازي': 'Sidi Allal Tazi', 'عرباوة': 'Arbaoua', 'سوق أربعاء الغرب': 'Souk El Arbaâ du Gharb', 'لالة ميمونة': 'Lalla Mimouna',
  'أولاد تايمة': 'Ouled Teïma', 'بيوكرى': 'Biougra', 'أيت ملول': 'Aït Melloul', 'الدشيرة الجهادية': 'Dcheira El Jihadia', 'إنزكان': 'Inezgane',
  'تمسية': 'Temsia', 'أولاد برحيل': 'Oulad Berhil', 'أكلو': 'Aglou', 'تافراوت': 'Tafraout', 'سيدي إفني': 'Sidi Ifni',
  'أسا': 'Assa', 'طرفاية': 'Tarfaya', 'بئر أنزران': 'Bir Anzarane', 'العيون الشرقية': 'El Aïoun Charkia', 'جرادة': 'Jerada',
  'عين بني مطهر': 'Aïn Béni Mathar', 'دبدو': 'Debdou', 'تيزنيت': 'Tiznit', 'ميرلفت': 'Mirleft', 'بلفاع': 'Belfaâ',
  'الخميسات': 'Khémisset', 'تيسة': 'Tissa', 'غفساي': 'Ghafsaï', 'قرية با محمد': 'Karia Ba Mohamed', 'تاهلة': 'Tahla',
  'أكنول': 'Aknoul', 'تيزي وسلي': 'Tizi Ouasli', 'بني ملال أولاد': 'Béni Mellal Oulad', 'فم الحصن': 'Fam El Hisn', 'أخفنير': 'Akhfennir',
});

/** City → French spelling for FR; unknown (admin-configured) cities unchanged. */
export function localizeCity(city, lang) {
  if (!isFr(lang) || typeof city !== 'string') return city;
  const key = city.trim();
  return Object.prototype.hasOwnProperty.call(CITY_FR, key) ? CITY_FR[key] : city;
}

/**
 * One /api/live-activity event → the same event with its server-written texts in
 * the market language. Data fields (amounts, counts, ids, avatar, real names) are
 * untouched. For 'ar' the SAME object is returned.
 */
export function localizeLiveActivityEvent(ev, lang) {
  if (!isFr(lang) || !ev || typeof ev !== 'object') return ev;
  const out = { ...ev };
  if ('name' in ev) out.name = localizeLiveName(ev.name, ev.personId, lang);
  if ('activity' in ev) out.activity = localizeLiveActivityText(ev.activity, lang);
  if ('detail' in ev) out.detail = localizeBoosterDetail(ev.detail, lang);
  if ('time' in ev) out.time = localizeRelTime(ev.time, lang);
  if ('city' in ev) out.city = localizeCity(ev.city, lang);
  return out;
}

// ── Recruitment live feed: formatLiveFeedEvent() templates (recruitmentCta.js) ─
// `name` is the already-masked first name (data, never translated); numbers are
// re-emitted exactly as the server wrote them.
const N = '(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)';
const plural = (n, one, many) => (Math.abs(Number(n)) < 2 ? one : many);
const ordinalFr = (n) => (Number(n) === 1 ? `${n}re` : `${n}e`);

export const LIVE_FEED_TEMPLATES = Object.freeze({
  new_affiliate:   { re: new RegExp('^(.*) انضمات للمنصة مؤخراً$'),     fr: ([name]) => `${name} a récemment rejoint la plateforme` },
  first_order:     { re: new RegExp('^(.*) أكدات أول طلب ديالها$'),     fr: ([name]) => `${name} a confirmé sa première commande` },
  order_milestone: { re: new RegExp(`^(.*) أكدات ${N} طلب اليوم$`),      fr: ([name, n]) => `${name} a confirmé ${n} ${plural(n, 'commande', 'commandes')} aujourd'hui` },
  team_milestone:  { re: new RegExp(`^فريق (.*) وصل لـ${N} عضو$`),       fr: ([name, n]) => `L'équipe de ${name} a atteint ${n} ${plural(n, 'membre', 'membres')}` },
  ugc_uploaded:    { re: new RegExp('^(.*) رفعات فيديو UGC ديالها$'),    fr: ([name]) => `${name} a publié sa vidéo UGC` },
  ugc_approved:    { re: new RegExp('^تم قبول فيديو UGC ديال (.*)$'),    fr: ([name]) => `La vidéo UGC de ${name} a été validée` },
  rank_change:     { re: new RegExp(`^(.*) فالمركز ${N} فالمنافسة$`),    fr: ([name, n]) => `${name} est à la ${ordinalFr(n)} place de la compétition` },
  badge_unlocked:  { re: new RegExp('^(.*) حصلات على Badge جديد$'),      fr: ([name]) => `${name} a obtenu un nouveau badge` },
});

/**
 * Parse a formatLiveFeedEvent() sentence back into { type, name, n } — the
 * event's `type` (when given) is tried first. Returns null when not recognised.
 */
export function parseLiveFeedText(text, type) {
  if (typeof text !== 'string') return null;
  const order = type && LIVE_FEED_TEMPLATES[type]
    ? [type, ...Object.keys(LIVE_FEED_TEMPLATES).filter((k) => k !== type)]
    : Object.keys(LIVE_FEED_TEMPLATES);
  for (const k of order) {
    const m = LIVE_FEED_TEMPLATES[k].re.exec(text);
    if (m) return { type: k, name: m[1], n: m[2] };
  }
  return null;
}

/** formatLiveFeedEvent() sentence → market language (unknown text unchanged). */
export function localizeLiveFeedText(text, type, lang) {
  if (!isFr(lang)) return text;
  const p = parseLiveFeedText(text, type);
  return p ? LIVE_FEED_TEMPLATES[p.type].fr([p.name, p.n]) : text;
}
