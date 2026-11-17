#!/usr/bin/env node
/**
 * scripts/demoCompUgcDashboard.test.mjs — affiliate dashboard tab "UGC Videos" (?tab=ugc-videos), the SIMULATED
 * Demo Competition leaderboard of UGC videos:
 *   1. navigation: tab id whitelisted (deep link), desktop tab bar, mobile More sheet; the real UGC tab ('ugc') unchanged;
 *   2. isolation: the tab reads ONLY /api/demo-competition/ugc-videos (no real UGC, orders, earnings, wallet, no auth);
 *   3. player: the only video element, native controls, no automatic playback, paused + unloaded on close,
 *      Esc / backdrop / close button, focus handling, above the bottom nav; the list holds images only;
 *   4. neutral wording: no demo / simulation badge, note or disclosure (product-owner decision); FR / AR keys complete;
 *   5. reuse of the shared Demo Competition components (no second polling / UI system);
 *   6. pure helpers executed (normalisation guards, podium split, view states).
 * Components are checked statically (the repo's convention for JSX).
 * Run: node scripts/demoCompUgcDashboard.test.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, String(extra).slice(0, 400)); } };
const strip = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

const N = await import('../src/lib/affiliateNav.js');
const { AFFILIATE_DASHBOARD_TEXT: DT } = await import('../src/lib/affiliateDashboardI18n.js');
const { SIMULATION_DISCLOSURE } = await import('../src/lib/demoCompetition/disclosure.js');
const U = await import('../src/components/demoCompetition/ugc/ugcVideos.js');

const TAB_PATH = 'src/app/affiliate/dashboard/UgcVideosTab.jsx';
const UGC_DIR = 'src/components/demoCompetition/ugc';
const ugcFiles = readdirSync(`${ROOT}${UGC_DIR}`).filter((f) => /\.jsx?$/.test(f)).map((f) => `${UGC_DIR}/${f}`);
const FILES = [TAB_PATH, ...ugcFiles];
const SRC = Object.fromEntries(FILES.map((f) => [f, read(f)]));
const CODE = Object.fromEntries(FILES.map((f) => [f, strip(SRC[f])]));
const ALL = Object.values(CODE).join('\n');
const TAB = CODE[TAB_PATH];
const CARDS = CODE[`${UGC_DIR}/UgcVideoCards.jsx`] || '';
const MODAL = CODE[`${UGC_DIR}/UgcVideoModal.jsx`] || '';
const PAGE = read('src/app/affiliate/dashboard/page.jsx');
const NAV = read('src/components/affiliate/MobileBottomNav.jsx');

// ── 1. Navigation ─────────────────────────────────────────────────────────────
console.log('1. Navigation (deep link, desktop tab bar, mobile More sheet)');
{
  ok('files exist (tab + cards + modal + pure helpers)', ['UgcVideoCards.jsx', 'UgcVideoModal.jsx', 'ugcVideos.js'].every((f) => ugcFiles.includes(`${UGC_DIR}/${f}`)) && existsSync(`${ROOT}${TAB_PATH}`));
  ok('"ugc-videos" is a whitelisted dashboard tab, distinct from the real "ugc" tab', N.DASHBOARD_TABS.includes('ugc-videos') && N.DASHBOARD_TABS.includes('ugc'));
  ok('parseDashboardTab: ?tab=ugc-videos → ugc-videos; ?tab=ugc still → the real UGC tab',
    N.parseDashboardTab('?tab=ugc-videos') === 'ugc-videos' && N.parseDashboardTab('?x=1&tab=ugc-videos') === 'ugc-videos' && N.parseDashboardTab('?tab=ugc') === 'ugc');
  ok('look-alike ids are refused', ['?tab=ugc-video', '?tab=UGC-VIDEOS', '?tab=ugc-videos%3Cx', '?tab=ugc_videos'].every((s) => N.parseDashboardTab(s) === null));
  ok('dashboardTabHref(ugc-videos) → /affiliate/dashboard?tab=ugc-videos', N.dashboardTabHref('ugc-videos') === '/affiliate/dashboard?tab=ugc-videos');
  ok('desktop tab bar: "ugc-videos" right after the real "ugc" tab (translated label)',
    /\{ id: "ugc",\s+label: t\("tab_ugc"\) \},\n\s+\{ id: "ugc-videos",\s+label: t\("tab_ugc_videos"\) \},/.test(PAGE));
  ok('the page renders the tab on its own id and keeps the real UGC tab',
    /import UgcVideosTab from "\.\/UgcVideosTab";/.test(PAGE) && /\{activeTab === "ugc-videos" && <UgcVideosTab \/>\}/.test(PAGE) && /\{activeTab === "ugc" && <UgcTab \/>\}/.test(PAGE));
  ok('mobile More sheet: "ugc-videos" entry after "UGC" (Clapperboard icon, translated label), settings still last',
    /tab: "ugc" \},\n\s+\{ icon: Clapperboard, label: t\("more_ugc_videos"\),\s+tab: "ugc-videos" \},/.test(NAV)
    && /Clapperboard,?\s*\n?\} from "lucide-react";/.test(NAV) && /const moreItems = \[[\s\S]*?tab: "settings" \},\n  \];/.test(NAV));
  ok('labels: FR « Vidéos UGC », AR « فيديوهات UGC » (desktop + More sheet)',
    DT.fr.tab_ugc_videos === 'Vidéos UGC' && DT.ar.tab_ugc_videos === 'فيديوهات UGC' && DT.fr.more_ugc_videos === 'Vidéos UGC' && DT.ar.more_ugc_videos === 'فيديوهات UGC');
}

// ── 2. Isolation ──────────────────────────────────────────────────────────────
console.log('\n2. Isolation: only the public demo endpoint');
{
  ok('endpoint constant = /api/demo-competition/ugc-videos (?limit=)', U.UGC_VIDEOS_ENDPOINT === '/api/demo-competition/ugc-videos' && U.UGC_VIDEOS_URL === `/api/demo-competition/ugc-videos?limit=${U.UGC_VIDEOS_LIMIT}` && U.UGC_VIDEOS_LIMIT >= 3 && U.UGC_VIDEOS_LIMIT <= 100);
  const apiRefs = [...ALL.matchAll(/["'`](\/api\/[^"'`$?]*)/g)].map((m) => m[1]);
  ok(`every API reference is the demo UGC endpoint (${apiRefs.length})`, apiRefs.length >= 1 && apiRefs.every((u) => u === '/api/demo-competition/ugc-videos'), apiRefs.join());
  ok('no real UGC / orders / earnings / wallet / payout / affiliate endpoint', !/\/api\/(affiliate|ugc|orders?|wallet|payout|earnings|admin)\b/i.test(ALL) && !/\/api\/affiliate\/ugc/.test(ALL));
  ok('no direct fetch / XHR: network only through the shared live poller', !/\bfetch\s*\(|XMLHttpRequest|axios/.test(ALL));
  ok('no auth: no token, no Authorization header, no localStorage', !/Authorization|affiliateToken|localStorage/.test(ALL));
  ok('polls the demo URL with useLivePolling (default interval = Top Members / Top Brands; paused when hidden / off-screen)',
    /useLivePolling\(UGC_VIDEOS_URL\)/.test(TAB) && !/intervalMs|setInterval/.test(ALL) && /ref=\{ref\}/.test(TAB));
  ok('the public route exists (GET, demo service)', /export const GET = h\.leaderboard;/.test(read('src/app/api/demo-competition/ugc-videos/route.js')));
  ok('no write method anywhere', !/method:\s*["'](POST|PUT|PATCH|DELETE)/.test(ALL));
}

// ── 3. Player + list ──────────────────────────────────────────────────────────
console.log('\n3. Player modal and list');
{
  const videoTags = FILES.filter((f) => /<video\b/.test(CODE[f]));
  ok('the ONLY video element is in the modal (list / cards / tab: images only)', videoTags.length === 1 && videoTags[0] === `${UGC_DIR}/UgcVideoModal.jsx`, videoTags.join());
  ok('thumbnails are lazy <img> (gradient + play icon fallback when null / broken)',
    /<img\b[\s\S]*?loading="lazy"[\s\S]*?onError=\{\(\) => setFailedSrc\(src\)\}/.test(CARDS) && /bg-gradient-to-br/.test(CARDS) && /<Play\b/.test(CARDS));
  const tag = (MODAL.match(/<video\b[\s\S]*?\/>/) || [''])[0];
  ok('video: src + controls + playsInline + preload="metadata"', /\bsrc=\{src\}/.test(tag) && /\bcontrols\b/.test(tag) && /\bplaysInline\b/.test(tag) && /preload="metadata"/.test(tag));
  ok('no automatic playback anywhere (no autoplay attribute, no .play() call)', !/autoplay|autoPlay/i.test(ALL) && !/\.play\(\)/.test(ALL));
  ok('pause + unload on close (src removed + load()) and pause when the browser tab is hidden',
    /el\.pause\(\); el\.removeAttribute\("src"\); el\.load\(\);/.test(MODAL) && /document\.hidden\) \{ try \{ el\.pause\(\);/.test(MODAL));
  ok('close: Esc, backdrop click (target only), close button', /e\.key === "Escape"/.test(MODAL) && /if \(e\.target === e\.currentTarget\) close\(\);/.test(MODAL) && /ref=\{closeRef\}[\s\S]*?onClick=\{close\}/.test(MODAL));
  ok('dialog semantics + focus: role=dialog, aria-modal, labelled by the title, focus on close button, Tab trapped, focus restored',
    /role="dialog"/.test(MODAL) && /aria-modal="true"/.test(MODAL) && /aria-labelledby=\{titleId\}/.test(MODAL) && /id=\{titleId\}/.test(MODAL)
    && /closeRef\.current\?\.focus\(\)/.test(MODAL) && /e\.key !== "Tab"/.test(MODAL) && /opener\.focus\(\)/.test(MODAL));
  ok('overlay above the mobile bottom nav (z-[65], like the dashboard modals) and page scroll locked',
    /className="fixed inset-0 z-\[65\]/.test(MODAL) && /document\.body\.style\.overflow = "hidden"/.test(MODAL) && /z-\[60\]/.test(NAV));
  ok('modal shows title, owner, rank, sales, reward per sale, total reward', /<RankBadge rank=\{video\.rank\}/.test(MODAL) && /video\.owner\.name/.test(MODAL)
    && /<SalesText sales=\{video\.sales\}/.test(MODAL) && /<PerSaleText cents=\{video\.rewardPerSaleCents\}/.test(MODAL) && /cents=\{video\.totalRewardCents\}/.test(MODAL));
  ok('guard: no playable URL → a message instead of an empty player', /playable \? \(/.test(MODAL) && /t\("ugcv_no_video"\)/.test(MODAL));
  ok('every card opens the player through a real <button type="button"> (keyboard accessible, labelled)',
    (CARDS.match(/<button\s+type="button"\s+onClick=\{\(\) => onOpen\(v\)\}\s+aria-label=\{playLabel\(v, t\)\}/g) || []).length === 2);
  ok('cards: rank, thumbnail, title, owner (Avatar), sales, reward per sale, total reward',
    ['PodiumCard', 'VideoRow'].every((c) => { const body = CARDS.slice(CARDS.indexOf(`export function ${c}(`)); const end = body.indexOf('\n}\n'); const b = body.slice(0, end);
      return /<VideoThumb\b/.test(b) && /\{v\.title\}/.test(b) && /<OwnerLine owner=\{v\.owner\}/.test(b) && /<SalesText/.test(b) && /<PerSaleText/.test(b) && /cents=\{v\.totalRewardCents\}/.test(b) && /v\.rank/.test(b); })
    && /<Avatar src=\{owner\.avatarUrl\}/.test(CARDS));
  ok('#1 is obvious: gold glow (flameClass), crown, "leader" ribbon, larger card first across the width',
    /flameClass\(v\.rank\)/.test(CARDS) && /first && <Crown className="dc-crown/.test(CARDS) && /t\("ugcv_leader"\)/.test(CARDS) && /"col-span-2 md:col-span-1 md:order-2"/.test(TAB));
  ok('podium (Top 3) then the list (rank 4+)', /splitPodium\(rows\)/.test(TAB) && /<PodiumCard\b/.test(TAB) && /<VideoRow\b/.test(TAB) && U.UGC_PODIUM_SIZE === 3);
}

// ── 4. Marking + texts ────────────────────────────────────────────────────────
console.log('\n4. Neutral wording (no visible demo / simulation marking) and FR / AR texts');
{
  const { fr, ar } = DT;
  // Product-owner decision: the affiliate UGC Videos interface shows NO "DÉMO · SIMULATION" badge and no explanatory
  // simulation wording; the data itself stays the isolated Demo Competition simulation (demo_comp_ugc_* only — §2/§3).
  const ugcvTexts = (d) => Object.entries(d).filter(([k]) => k.startsWith('ugcv_')).map(([, v]) => String(v));
  ok('no badge / note dictionary keys any more (FR + AR)', !('ugcv_badge' in fr) && !('ugcv_note' in fr) && !('ugcv_badge' in ar) && !('ugcv_note' in ar));
  ok('no demo / simulation word in any ugcv_* text (FR + AR)',
    ugcvTexts(fr).every((v) => !/d[ée]mo|simul/i.test(v)) && ugcvTexts(ar).every((v) => !/محاكا|تجريبي/.test(v)), [...ugcvTexts(fr), ...ugcvTexts(ar)].filter((v) => /d[ée]mo|simul|محاكا|تجريبي/i.test(v)));
  ok('the tab and the player render no demo badge / note (no data-demo-badge / data-demo-note, no ugcv_badge / ugcv_note)',
    FILES.every((f) => !/data-demo-badge|data-demo-note|ugcv_badge|ugcv_note/.test(CODE[f])));
  ok('no central simulation disclosure on this tab (not imported, not copied)',
    FILES.every((f) => !/simulationDisclosure|demoCompetition\/disclosure/.test(SRC[f]) && !SRC[f].includes(SIMULATION_DISCLOSURE.text.fr) && !SRC[f].includes(SIMULATION_DISCLOSURE.text.ar)));
  const used = new Set(FILES.flatMap((f) => [...CODE[f].matchAll(/\bt\(\s*(?:[^()"']*?\?\s*)?"([a-z0-9_]+)"(?:\s*:\s*"([a-z0-9_]+)")?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean)));
  const missing = [...used].filter((k) => !(k in fr) || !(k in ar) || !String(fr[k]).trim() || !String(ar[k]).trim());
  ok(`every text key used by the tab exists, non-empty, in FR and AR (${used.size} keys)`, used.size >= 20 && missing.length === 0, missing.join());
  const ugcv = Object.keys(fr).filter((k) => k.startsWith('ugcv_'));
  ok(`ugcv_* keys: same set in FR and AR, all used (${ugcv.length})`, ugcv.length > 0 && ugcv.every((k) => k in ar) && Object.keys(ar).filter((k) => k.startsWith('ugcv_')).length === ugcv.length
    && ugcv.every((k) => FILES.some((f) => SRC[f].includes(`"${k}"`))), ugcv.filter((k) => !FILES.some((f) => SRC[f].includes(`"${k}"`))).join());
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  ok('same placeholders in FR and AR; Arabic values are Arabic', ugcv.every((k) => ph(fr[k]) === ph(ar[k])) && ugcv.every((k) => /[؀-ۿ]/.test(ar[k])));
  ok('disabled state text (FR) as specified', fr.ugcv_disabled_title === "La compétition UGC n'est pas active pour le moment");
  ok('reward per sale reads "<amount> / vente" (amount = Money: "6 DH")', fr.ugcv_per_sale === '{amount} / vente' && /\{amount\}/.test(ar.ugcv_per_sale) && /fillParts\(t\("ugcv_per_sale"\), \{ amount: <Money/.test(CARDS));
  ok('no hard-coded French / Arabic text in the tab files', !/[؀-ۿ]/.test(ALL) && !/[àâçéèêëîïôùûœÉÈ]/.test(ALL));
}

// ── 5. Reuse + layout ─────────────────────────────────────────────────────────
console.log('\n5. Reuse of the Demo Competition components, states, RTL / mobile');
{
  const imp = Object.values(SRC).join('\n');
  ok('live poller + rank diffs + demo texts from the shared hook', /import \{ useDemoText, useLivePolling, useRankDiff \} from "@\/components\/demoCompetition\/useLivePolling";/.test(imp) && /useRankDiff\(rows, "totalRewardCents"\)/.test(TAB));
  ok('shared UI: Avatar, Money / Count, RankBadge / MovementIndicator, flame, LeaderboardSkeleton, demoCompetition.css',
    /import Avatar from "\.\.\/Avatar";/.test(imp) && /import \{ Count, Money \} from "\.\.\/CountUp";/.test(imp) && /import \{ MovementIndicator, RankBadge \} from "\.\.\/Badges";/.test(imp)
    && /import \{ flameClass \} from "\.\.\/flame";/.test(imp) && /import \{ LeaderboardSkeleton \} from "@\/components\/demoCompetition\/LeaderboardList";/.test(imp)
    && /demoCompetition\/demoCompetition\.css"|"\.\.\/demoCompetition\.css"/.test(imp) && /dc-card|dc-row/.test(CARDS));
  ok('dashboard dictionary + market language (useMarketLocale), demo badges in the same language', /useMarketLocale\(AFFILIATE_DASHBOARD_TEXT\)/.test(TAB) && /useDemoText\(lang\)/.test(TAB));
  ok('states: loading skeleton, error + retry, disabled, empty, stale notice', /view === "loading" && <LeaderboardSkeleton/.test(TAB) && /view === "error"[\s\S]*?onClick=\{onRetry\}[\s\S]*?t\("retry"\)/.test(TAB)
    && /view === "disabled"[\s\S]*?t\("ugcv_disabled_title"\)/.test(TAB) && /view === "empty"[\s\S]*?t\("ugcv_empty"\)/.test(TAB) && /\{error && \([\s\S]*?t\("ugcv_stale"\)/.test(TAB));
  ok('retry remounts the board (fresh poller, immediate fetch)', /<UgcVideosBoard key=\{attempt\} onRetry=\{\(\) => setAttempt\(\(n\) => n \+ 1\)\} \/>/.test(TAB));
  ok('direction: tab section and dialog carry the market dir / lang; names / titles bidi-isolated',
    /<section ref=\{ref\} dir=\{dir\} lang=\{lang\}/.test(TAB) && /dir=\{dir\}\s+lang=\{lang\}/.test(MODAL) && (ALL.match(/<bdi\b/g) || []).length >= 5);
  const physical = ALL.match(/(?<![\w-])(text-left|text-right|ml-\d|mr-\d|pl-\d|pr-\d|left-\d|right-\d|rounded-[lr]-)/g) || [];
  ok('logical spacing / alignment classes only (RTL mirroring)', physical.length === 0, physical.join());
  const wide = [...ALL.matchAll(/\b(?:min-)?w-\[(\d+)px\]/g)].filter((m) => Number(m[1]) > 320).map((m) => m[0]);
  ok('mobile first: no fixed width over 320 px, podium 2 columns on phones, list one column', wide.length === 0 && /grid grid-cols-2 gap-3 md:grid-cols-3/.test(TAB) && /grid grid-cols-1 gap-2 lg:grid-cols-2/.test(TAB), wide.join());
  ok('the modal sits outside the spaced section (its fixed overlay is never offset)', /<\/section>\s*\{current && \(\s*<UgcVideoModal/.test(TAB));
}

// ── 6. Pure helpers ───────────────────────────────────────────────────────────
console.log('\n6. Pure helpers');
{
  const api = [
    { rank: 1, videoId: 'v1', title: 'A', thumbnailUrl: null, videoUrl: 'https://cdn.x/a.mp4', owner: { id: 'm1', name: 'Sara', avatarUrl: null, public: true }, sales: 12, rewardPerSale: 6, totalReward: 72, totalRewardCents: 7200, simulated: true },
    { rank: 2, videoId: 'v2', title: 'B', thumbnailUrl: '/uploads/b.jpg', videoUrl: '/uploads/b.mp4', owner: { id: 'm1', name: 'Sara', avatarUrl: 'javascript:alert(1)' }, sales: 5, rewardPerSale: 7, totalReward: 35, simulated: true },
    { rank: 3, videoId: 'v3', title: 'C', videoUrl: null, sales: 9 },
    { rank: 4, videoId: 'v4', title: 'D', videoUrl: 'javascript:alert(1)', sales: 9 },
    { rank: 5, videoId: 'v5', title: 'E', thumbnailUrl: '//evil/x.jpg', videoUrl: 'https://cdn.x/e.mp4', owner: null, sales: -3, rewardPerSale: 5, totalRewardCents: 'x' },
    null,
  ];
  const rows = U.normalizeUgcVideos(api);
  ok('rows without a playable video URL are dropped (null, javascript:)', rows.map((r) => r.id).join() === 'v1,v2,v5');
  ok('same owner may rank several videos', rows.filter((r) => r.owner?.id === 'm1').length === 2);
  ok('amounts in centimes: reward per sale 6 → 600; total from totalRewardCents, else totalReward × 100',
    rows[0].rewardPerSaleCents === 600 && rows[0].totalRewardCents === 7200 && rows[1].totalRewardCents === 3500 && rows[1].rewardPerSaleCents === 700);
  ok('unsafe media URLs → null (protocol-relative thumbnail, javascript: avatar); null owner kept as null; negative / invalid → 0',
    rows[2].thumbnailUrl === null && rows[1].owner.avatarUrl === null && rows[1].thumbnailUrl === '/uploads/b.jpg' && rows[2].owner === null && rows[2].sales === 0 && rows[2].totalRewardCents === 0);
  ok('normalize: not an array → []', U.normalizeUgcVideos(undefined).length === 0 && U.normalizeUgcVideos({}).length === 0);
  const sp = U.splitPodium(rows.concat([{ id: 'z', rank: 4 }]));
  ok('splitPodium: first 3 on the podium, the rest in the list', sp.podium.length === 3 && sp.rest.length === 1 && U.splitPodium(null).podium.length === 0);
  ok('view states', U.ugcViewState({ data: null, error: null }) === 'loading' && U.ugcViewState({ data: null, error: new Error('x') }) === 'error'
    && U.ugcViewState({ notFound: true }) === 'disabled' && U.ugcViewState({ data: { enabled: false, videos: [] }, rows: [] }) === 'disabled'
    && U.ugcViewState({ data: { enabled: true, videos: [] }, rows: [] }) === 'empty' && U.ugcViewState({ data: { enabled: true }, rows }) === 'ready'
    && U.ugcViewState({ data: { enabled: true }, rows, error: new Error('stale') }) === 'ready');
  ok('safeMediaUrl', U.safeMediaUrl('https://a.b/c.mp4') === 'https://a.b/c.mp4' && U.safeMediaUrl('/x.mp4') === '/x.mp4'
    && [null, '', ' ', '//x', 'data:video/mp4;base64,AA', 'javascript:x', 'ftp://x', 'a b'].every((u) => U.safeMediaUrl(u) === null));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
