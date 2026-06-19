/**
 * Meta (Facebook) Ads Library scraper
 * --------------------------------------------------------------------------
 * This replaces what the Manus agent was doing in those screenshots.
 *
 * Manus's problem: it loaded the page, grabbed the RENDERED HTML, then wrote a
 * BeautifulSoup parser from scratch every run and looped 15-20 times trying to
 * "find a more robust method" because Facebook's HTML has randomized/obfuscated
 * class names. That trial-and-error loop was the 90% time sink.
 *
 * What this does instead: the Ads Library page fetches its data from Facebook's
 * internal GraphQL endpoint (/api/graphql/) as clean JSON. We let the page make
 * those calls, INTERCEPT the responses, and read the structured JSON directly.
 * No HTML parsing, no guessing, deterministic every run.
 *
 * Output per lead (their Step 1 fields, plus extras that come free):
 *   adLink, landingPage, fanPage, companyName  (+ pageId, body, cta, displayUrl)
 *
 * Steps 2/3 (Apollo enrich, Sheets, Instantly/GHL) plug in where marked TODO.
 *
 * Usage:
 *   node scrape-ads.js --terms "tax services,bookkeeping for agencies" --country US --max 50
 *   node scrape-ads.js --terms-file terms.txt --max 100 --concurrency 3 --classify --out leads.json
 *   node scrape-ads.js --terms "coaching" --existing existing.json   # dedup like the 529-company run
 */

import { chromium } from "playwright";
import { writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1. CONFIG (override any of these via CLI flags)
// ---------------------------------------------------------------------------
const DEFAULTS = {
  country: "US",
  max: 50,            // target unique leads PER search term
  concurrency: 1,     // one term at a time — prevents OOM on 2GB server
  classify: false,    // fetch landing pages and tag opt-in / vsl / booking
  headless: true,
  out: "leads.json",
  // stop scrolling a term once this many consecutive scrolls add nothing new.
  // Higher = digs deeper into Meta's result set before giving up (more leads,
  // slower). Override with --idle. Filtered (AND/phrase) terms multiply this.
  maxIdleScrolls: parseInt(process.env.SCRAPE_IDLE_SCROLLS || "8", 10),
  scrollDelayMs: 1800, // give GraphQL pagination time to fire + return
  navTimeoutMs: 60000,
  // How many fresh proxy IPs to try before giving up on a term. Residential
  // pools have many flagged IPs at any moment; with a 97-IP pool, burning
  // through more of them dramatically raises the odds of hitting one Facebook
  // will actually serve the search to.
  maxAttempts: parseInt(process.env.SCRAPE_MAX_ATTEMPTS || "12", 10),
  // Seconds to wait for the search GraphQL to fire on a loaded page before
  // declaring the IP throttled and rotating. Slow residential IPs sometimes
  // fire the search late, so give them room.
  gqlWaitSec: parseInt(process.env.SCRAPE_GQL_WAIT_SEC || "20", 10),
  // A single "all" pass is best on one IP — splitting into image/video/meme runs
  // 3 sessions that get progressively throttled and dedupe to the same companies,
  // yielding FEWER results. Media-split only helps with strong rotating proxies
  // (each pass on a fresh IP). Override with --media "image,video,meme" to try it.
  mediaTypes: (process.env.SCRAPE_MEDIA_TYPES || "all")
    .split(",").map((s) => s.trim()).filter(Boolean),
};

// ---------------------------------------------------------------------------
// 2. SEARCH-TERM GRAMMAR  +  URL BUILDER
// ---------------------------------------------------------------------------
// The scraper mirrors the Meta Ads Library exactly — we send the query the way
// Meta interprets it and return what Meta returns (no extra filtering on our
// side). One search term from the box can be:
//   CPA                  -> keyword search (Meta matches loosely across copy,
//                           page name, caption, landing page)
//   CPA book a call      -> Meta requires all the words present (its native
//                           loose AND), same as typing it into the Ads Library
//   CPA AND book a call  -> identical to above; "AND"/"&&" is just a readable
//                           separator we strip before sending to Meta
//   "book a call"        -> EXACT PHRASE (Meta's "Search this exact phrase")
// Commas separate independent searches (OR / union) and are split earlier, so a
// single `term` here is one Meta search.
// True only when quotes wrap the WHOLE term with nothing quoted inside — so
// `"strategy session"` is a phrase, but `"a" AND "b"` is not (two phrases).
function isQuoted(s) {
  const t = s.trim();
  return /^"[^"]+"$/.test(t) || /^'[^']+'$/.test(t);
}

// Break a term into the substrings that must ALL appear in the ad:
//   "book a call" (quoted)   -> one token  "book a call"  (exact phrase)
//   book a call / book AND call -> tokens  "book", "call" (each word, anywhere)
//   CPA                      -> "cpa"
// "AND"/"&&" are treated as separators; tiny words ("a", "i") are dropped.
function requiredTokens(term) {
  const tokens = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let m;
  while ((m = re.exec(term)) !== null) {
    const phrase = m[1] || m[2];
    if (phrase) {
      tokens.push(phrase.trim().toLowerCase());
    } else {
      const w = m[3].toLowerCase();
      if (/^(and|&&)$/.test(w)) continue;     // operator, skip
      if (w.length >= 2) tokens.push(w);        // drop "a", "i"
    }
  }
  return tokens;
}

function parseTerm(term) {
  const t = term.trim();

  // Fully-quoted -> exact phrase, like Meta's "Search this exact phrase". We STILL
  // post-filter: Meta's exact-phrase match also hits hidden fields (e.g. the
  // landing page), so it can return ads where the phrase isn't in the visible ad.
  // The client's main complaint was exactly that — so we verify the phrase really
  // appears in the ad text.
  if (isQuoted(t)) {
    const phrase = t.slice(1, -1).trim();
    return { metaQuery: phrase, searchType: "keyword_exact_phrase", required: [phrase.toLowerCase()] };
  }

  // Otherwise: send the words to Meta to narrow the crawl, then keep only ads
  // whose text actually CONTAINS every word/phrase. This is the client's core
  // requirement — the search term must really appear in the ad, not just be a
  // loose Meta match across hidden fields. Spaces = implicit AND.
  const metaQuery = t
    .replace(/["']/g, " ")
    .replace(/\s+AND\s+/gi, " ")
    .replace(/&&/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { metaQuery: metaQuery || t, searchType: "keyword_unordered", required: requiredTokens(t) };
}

// The ad text we check the required tokens against — company, headline, the line
// by the button, body copy, CTA button label, and the URLs.
function leadSearchText(lead) {
  return [
    lead.companyName, lead.adTitle, lead.adLinkDescription, lead.adCopySnippet,
    lead.cta, lead.website, lead.landingPage, lead.displayUrl,
  ]
    .map((v) => (v == null ? "" : String(v)))
    .join("  ")
    .toLowerCase();
}

// An ad passes when every required token is present somewhere in its text.
function matchesRequired(required, text) {
  return required.every((tok) => text.includes(tok));
}

function buildSearchUrl(parsed, country, mediaType = "all") {
  const params = new URLSearchParams({
    active_status: "all",
    ad_type: "all",
    country,
    q: parsed.metaQuery,
    search_type: parsed.searchType,
    media_type: mediaType,
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// 3. GRAPHQL RESPONSE PARSING
// Facebook's GraphQL responses have two quirks:
//   - they may be prefixed with `for (;;);` (anti-JSON-hijacking guard)
//   - they may be NDJSON: several JSON objects, one per line (@defer streaming)
// So we strip the guard, split on newlines, and parse each line independently.
// ---------------------------------------------------------------------------
function parseGraphQLBody(text) {
  const out = [];
  const cleaned = text.replace(/^for \(;;\);/, "").trim();
  for (const line of cleaned.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // not valid JSON on its own (partial/streamed chunk) — ignore safely
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. RECURSIVE AD-NODE EXTRACTOR
// Rather than depend on an exact JSON path (which Facebook changes), we walk
// the whole object and collect any node that carries an `ad_archive_id`. That
// is the reliable marker of an ad result and survives most structure changes.
// ---------------------------------------------------------------------------
function extractAdNodes(obj, found = []) {
  if (!obj || typeof obj !== "object") return found;
  if (Array.isArray(obj)) {
    for (const item of obj) extractAdNodes(item, found);
    return found;
  }
  if ("ad_archive_id" in obj || "adArchiveID" in obj) {
    found.push(obj);
  }
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === "object") extractAdNodes(val, found);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 5a. AD CREATIVE LINK
// Their SOP: "scrape the actual ad link that plays the ad. Never the Ads
// Library link." The creative lives in the snapshot. Video ads -> direct video
// URL (plays). Image ads -> image URL (the creative; there is no video to play).
// IMPORTANT: these fbcdn URLs are time-signed and EXPIRE (note the `oe=` field),
// so a link stored in a sheet goes dead within hours/days. We therefore also
// return the PERMANENT per-ad permalink as a fallback the team can choose.
// ---------------------------------------------------------------------------
function pickCreativeFrom(obj) {
  if (!obj) return null;
  const vids = obj.videos || (obj.video ? [obj.video] : []);
  const v = Array.isArray(vids) ? vids[0] : vids;
  if (v && (v.video_hd_url || v.video_sd_url)) {
    return { url: v.video_hd_url || v.video_sd_url, mediaType: "video" };
  }
  const imgs = obj.images || (obj.image ? [obj.image] : []);
  const img = Array.isArray(imgs) ? imgs[0] : imgs;
  if (img && (img.original_image_url || img.resized_image_url)) {
    return { url: img.original_image_url || img.resized_image_url, mediaType: "image" };
  }
  // single-card fields sometimes sit directly on the object (carousel cards)
  if (obj.video_hd_url || obj.video_sd_url) {
    return { url: obj.video_hd_url || obj.video_sd_url, mediaType: "video" };
  }
  if (obj.original_image_url || obj.resized_image_url) {
    return { url: obj.original_image_url || obj.resized_image_url, mediaType: "image" };
  }
  return null;
}

function getAdCreative(snap, adArchiveId) {
  // 1) top-level creative (single image/video ads)
  let c = pickCreativeFrom(snap);
  if (c) return c;
  // 2) carousel / dynamic catalog ads keep creatives inside cards[]
  if (Array.isArray(snap.cards)) {
    for (const card of snap.cards) {
      c = pickCreativeFrom(card);
      if (c) return c;
    }
  }
  // 3) explicit link field
  if (snap.creative_link_url || snap.ad_creative_link_url) {
    return { url: snap.creative_link_url || snap.ad_creative_link_url, mediaType: "link" };
  }
  return { url: null, mediaType: null };
}

// 5a-ii. AD COPY — skip unfilled dynamic templates like "{{product.brand}}".
// Catalog/dynamic ads put template tokens in the top-level body; the real copy
// is usually in cards[], title, or link_description. Return the first text that
// has real words after stripping {{...}} tokens.
function usableText(t) {
  if (!t) return null;
  const s = String(t).trim();
  const stripped = s.replace(/\{\{[^}]*\}\}/g, "").trim();
  return stripped.length >= 5 ? s : null; // pure-template/blank -> null
}
function getAdCopy(snap) {
  const cards = Array.isArray(snap.cards) ? snap.cards : [];
  const candidates = [
    snap.body && (snap.body.text || snap.body.markup?.__html),
    ...cards.map((c) => c.body && (c.body.text || c.body)),
    ...cards.map((c) => c.title),
    snap.title,
    snap.link_description,
    snap.byline,
  ];
  for (const cand of candidates) {
    const ok = usableText(cand);
    if (ok) return ok.slice(0, 2000); // keep enough text so the keyword filter sees the whole ad
  }
  return null;
}

// Return the first usable text among the candidates (template tokens stripped),
// capped. Used to surface the headline and link-description on their own —
// the search term often lives there (the bold title / the line by the button)
// rather than in the body copy.
function firstUsable(cands, cap = 300) {
  for (const cand of cands) {
    const ok = usableText(cand);
    if (ok) return ok.slice(0, cap);
  }
  return null;
}

// 5a-iii. LANDING PAGE — reach into cards[] for carousel ads, and recognise
// Facebook-internal destinations. Lead-form / Messenger / video-view ads have
// NO external landing page; Facebook returns a bare "fb.me" or nothing. We flag
// those as their true destination type instead of storing a useless http://fb.me/.
const FB_INTERNAL = /(^|\.)(fb\.me|facebook\.com|fb\.com|fb\.watch|m\.me|messenger\.com|instagram\.com)$/i;
function destinationType(url) {
  if (!url) return "none";
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return "none"; }
  if (!FB_INTERNAL.test(host)) return "external";
  if (/m\.me|messenger/.test(host)) return "messenger";
  if (/instagram/.test(host)) return "instagram";
  return "facebook_lead_form"; // fb.me / facebook.com with no external target
}
function getLandingPage(snap) {
  const candidates = [];
  if (snap.link_url) candidates.push(snap.link_url);
  if (Array.isArray(snap.cards)) {
    for (const c of snap.cards) if (c.link_url) candidates.push(c.link_url);
  }
  // prefer the first real EXTERNAL url
  for (const u of candidates) {
    if (destinationType(u) === "external") return { url: u, type: "external" };
  }
  // otherwise it's a Facebook-internal destination (lead form / messenger) or none
  if (candidates.length) return { url: null, type: destinationType(candidates[0]) };
  return { url: null, type: "none" };
}

// 5a-iv. US PHONE VALIDATION — reject garbage like "10008975000" (area code 000)
function validUSPhone(input) {
  if (!input) return null;
  let d = String(input).replace(/[^\d]/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (d.length !== 10) return null;
  // area code and exchange code must each start 2-9 (NANP rule)
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null;
  return "1" + d; // match the sheet's 11-digit format e.g. 13478347801
}

// International-friendly normaliser for a phone the page DECLARES (e.g. FB's
// "phone" field). Keeps a leading + and 7-15 digits; used for non-US numbers
// like Uganda's +256703380377 that the strict US validator would reject.
function normalizePhone(input) {
  if (!input) return null;
  const hasPlus = String(input).trim().startsWith("+");
  const d = String(input).replace(/[^\d]/g, "");
  if (d.length < 7 || d.length > 15) return null;
  return hasPlus ? "+" + d : d;
}

// Social / link-aggregator hosts — a page's links to these are NOT its website.
// Hostname-based (not a substring regex) so full domains like x.com, wa.me and
// t.me are matched correctly.
const SOCIAL_HOSTS = [
  "facebook.com", "fb.com", "fb.me", "instagram.com", "twitter.com", "x.com",
  "linkedin.com", "youtube.com", "youtu.be", "tiktok.com", "threads.net",
  "pinterest.com", "wa.me", "whatsapp.com", "messenger.com", "m.me",
  "t.me", "telegram.me", "snapchat.com",
];
function isSocialUrl(u) {
  let host;
  try { host = new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return true; }
  return SOCIAL_HOSTS.some((s) => host === s || host.endsWith("." + s));
}

// 5b. DERIVE THE REAL COMPANY DOMAIN/WEBSITE
// The landing page is usually a funnel SUBDOMAIN (go.acme.com), not the real
// site. The displayed caption is usually the clean domain (acme.com), which is
// what Apollo needs. Prefer caption, fall back to the registrable root of the
// landing page. (A fan-page visit can still override this when --enrich-page.)
function registrableDomain(host) {
  if (!host) return null;
  const parts = host.replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join("."); // good enough for .com/.org/.net etc.
}
function deriveWebsite(snap, landingPage) {
  const caption = (snap.caption || "").trim().toLowerCase();
  if (caption && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(caption.replace(/^https?:\/\//, "").split("/")[0])) {
    const host = caption.replace(/^https?:\/\//, "").split("/")[0];
    return `https://www.${registrableDomain(host)}`;
  }
  try {
    if (landingPage) {
      const host = new URL(landingPage).hostname;
      const root = registrableDomain(host);
      if (root) return `https://www.${root}`;
    }
  } catch { /* malformed */ }
  return null;
}

// ---------------------------------------------------------------------------
// 5c. NORMALISE ONE RAW NODE INTO A CLEAN LEAD (10 SOP attributes)
// Defensive field access: Facebook moves fields between the node root and the
// `snapshot` object depending on the query, so we check both.
// ---------------------------------------------------------------------------
function normalizeAd(node) {
  const snap = node.snapshot || node.snapshots || {};
  const adArchiveId = node.ad_archive_id || node.adArchiveID || null;
  const pageId = node.page_id || snap.page_id || node.pageID || null;
  const companyName = node.page_name || snap.page_name || node.pageName || null;

  const lp = getLandingPage(snap);

  const adCopy = getAdCopy(snap);

  // Headline + the description line next to the CTA button. These often contain
  // the search term even when the body copy doesn't. Fall back to the first
  // card's fields for carousel/multi-card ads.
  const cards = Array.isArray(snap.cards) ? snap.cards : [];
  const adTitle = firstUsable([snap.title, ...cards.map((c) => c.title)]);
  const adLinkDescription = firstUsable([
    snap.link_description,
    ...cards.map((c) => c.link_description),
  ]);

  const creative = getAdCreative(snap, adArchiveId);

  // node-level collation count if Facebook provides it (how many ads collated
  // under this page for the search); otherwise filled in later by grouping.
  const collationCount =
    node.collation_count || node.collationCount ||
    (Array.isArray(node.collated_results) ? node.collated_results.length : null);

  return {
    // --- scraped from the AD ---
    companyName: companyName ? companyName.trim() : null,
    facebookPageId: pageId,
    fbAdLink: creative.url,                      // playable/creative media (EXPIRES)
    mediaType: creative.mediaType,               // "video" | "image" | "link"
    adPermalink: adArchiveId                      // PERMANENT Ads Library URL for this ad
      ? `https://www.facebook.com/ads/library/?id=${adArchiveId}`
      : null,
    landingPage: lp.url,                          // null for lead-form/messenger/video ads
    destinationType: lp.type,                     // external | facebook_lead_form | messenger | instagram | none
    adCopySnippet: adCopy,
    adTitle,                                      // bold headline by the creative
    adLinkDescription,                            // line next to the CTA button
    activeAdCount: collationCount,              // refined after grouping in main()
    // --- from / about the FAN PAGE ---
    facebookProfile: pageId ? `https://www.facebook.com/${pageId}` : null,
    website: deriveWebsite(snap, lp.url),       // overridden by fan-page visit if enabled
    companyPhone: null,                         // filled by fan-page visit (--enrich-page)
    instagramProfile: snap.instagram_actor_name
      ? `https://www.instagram.com/${snap.instagram_actor_name}`
      : null,                                   // often null; fan-page visit can find it
    // --- references kept for dedup / debugging ---
    adArchiveId,
    displayUrl: snap.caption || null,
    cta: snap.cta_text || snap.cta_type || null,
  };
}

// ---------------------------------------------------------------------------
// 6. DEDUP KEY — their SOP dedupes on Facebook Page ID AND company domain.
// We build a composite key so either match catches a duplicate.
// ---------------------------------------------------------------------------
function leadKey(lead) {
  if (lead.facebookPageId) return `pid:${lead.facebookPageId}`;
  let domain = "";
  try {
    const src = lead.website || lead.landingPage;
    if (src) domain = new URL(src).hostname.replace(/^www\./, "");
  } catch { /* malformed url */ }
  if (domain) return `dom:${domain}`;
  const name = (lead.companyName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return name ? `name:${name}` : (lead.adArchiveId || JSON.stringify(lead));
}

// ---------------------------------------------------------------------------
// 6b. PROXY POOL — residential IPs are flaky, so we rotate across a pool and
// pick a fresh one per attempt. Sources (first non-empty wins):
//   PROXY_LIST : newline/comma separated "host:port:user:pass" (or full URLs)
//   PROXY_URL (+ PROXY_USERNAME/PROXY_PASSWORD) : a single proxy
// ---------------------------------------------------------------------------
function parseProxyLine(line) {
  const s = (line || "").trim();
  if (!s) return null;
  if (/^\w+:\/\//.test(s)) {
    try {
      const u = new URL(s);
      return {
        server: `${u.protocol}//${u.host}`,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      };
    } catch { return null; }
  }
  const parts = s.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...rest] = parts;
    return { server: `http://${host}:${port}`, username: user, password: rest.join(":") };
  }
  if (parts.length === 2) return { server: `http://${parts[0]}:${parts[1]}` };
  return null;
}

function loadProxies() {
  const out = [];
  const pushLines = (text) => {
    for (const line of (text || "").split(/[\r\n,]+/)) {
      const p = parseProxyLine(line);
      if (p) out.push(p);
    }
  };

  pushLines(process.env.PROXY_LIST);

  // Fallback: a local proxies file, so the server never accidentally scrapes on
  // the host IP just because the PROXY_LIST env var wasn't set. Looks next to the
  // script (PROXY_FILE overrides the filename).
  if (!out.length) {
    const file = process.env.PROXY_FILE || "proxies.local.txt";
    for (const candidate of [file, path.join(SCRIPT_DIR, file)]) {
      try {
        pushLines(readFileSync(candidate, "utf8"));
        if (out.length) {
          console.log(`Loaded proxies from file: ${candidate}`);
          break;
        }
      } catch { /* file not present — try next */ }
    }
  }

  if (!out.length && process.env.PROXY_URL) {
    out.push({
      server: process.env.PROXY_URL,
      username: process.env.PROXY_USERNAME || undefined,
      password: process.env.PROXY_PASSWORD || undefined,
    });
  }
  return out;
}

function proxyKey(p) {
  return p ? `${p.server}|${p.username || ""}` : "";
}

// Pick a random proxy, preferring one not already tried this round so retries
// don't waste an attempt on the same bad IP.
function pickProxy(proxies, tried) {
  if (!proxies || !proxies.length) return undefined;
  const untried = tried ? proxies.filter((p) => !tried.has(proxyKey(p))) : proxies;
  const pool = untried.length ? untried : proxies;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Abort everything we don't need — images, video, fonts, CSS — for every page in
// a context. We only need the page's scripts (to fire the search) and the GraphQL
// JSON; nothing is rendered/looked at visually. This cuts proxy bandwidth ~90%+ —
// critical on per-GB residential proxies. Safe for classify: <video>/<iframe> DOM
// elements still exist; we just skip their bytes. Set NO_BLOCK_MEDIA=1 to disable.
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);
// Facebook STREAMS ad-preview videos via fetch/XHR (MSE/DASH), so they're typed
// "fetch" and dodge the resourceType filter — they were the real hogs (100-230MB
// each). Block them by URL instead. The video CDN is never needed; the ad's video
// link is just a string in the GraphQL JSON we read from facebook.com.
function isHeavyUrl(u) {
  return /video[\w.-]*\.fbcdn\.net/i.test(u) || /\.mp4(\?|$)/i.test(u);
}
async function blockHeavyAssets(context) {
  if (process.env.NO_BLOCK_MEDIA) return;
  await context.route("**/*", (route) => {
    const req = route.request();
    if (BLOCKED_RESOURCE_TYPES.has(req.resourceType()) || isHeavyUrl(req.url())) {
      return route.abort();
    }
    return route.continue();
  });
}

// ---------------------------------------------------------------------------
// 7. SCRAPE A SINGLE SEARCH TERM
// ---------------------------------------------------------------------------
async function scrapeTerm(browser, term, cfg, seenKeys) {
  const rawNodes = [];
  let gqlResponses = 0;   // how many GraphQL responses we saw (diagnostic)
  let gqlWithAdData = 0;  // how many of them actually contained ad data
  let gqlReadErrors = 0;  // how many response bodies we failed to read

  // Attach the GraphQL interceptor that pulls ad nodes out of each response.
  const attachInterceptor = (pg) => {
    pg.on("response", async (response) => {
      const u = response.url();
      if (!u.includes("/api/graphql") && !u.includes("/graphql")) return;
      gqlResponses++;
      if (response.status() !== 200) return;
      try {
        const text = await response.text();
        if (text.includes("ad_archive_id") || text.includes("adArchiveID")) gqlWithAdData++;
        for (const obj of parseGraphQLBody(text)) extractAdNodes(obj, rawNodes);
      } catch {
        gqlReadErrors++; // body already consumed / non-text
      }
    });
  };

  const results = new Map(); // key -> normalized lead (per-term dedup, across passes)
  const seenArchive = new Set(); // every raw ad id seen across all passes (dedup + scan count)
  const parsed = parseTerm(term);
  if (parsed.required.length) {
    console.log(`  [${term}] → Meta q="${parsed.metaQuery}", keep only ads containing: ${parsed.required.map((r) => `"${r}"`).join(" + ")}`);
  } else if (parsed.metaQuery !== term.trim()) {
    console.log(`  [${term}] → Meta q="${parsed.metaQuery}" (${parsed.searchType})`);
  }

  // One pass per media type. Meta caps each stream at ~1,000 ads; image/video/meme
  // are separate streams, so passing each and merging breaks the single-pass cap.
  const mediaTypes = (cfg.mediaTypes && cfg.mediaTypes.length) ? cfg.mediaTypes : ["all"];

  // Acquire a ready (search-fired) context for one media-type URL, then scroll it
  // to exhaustion, merging new advertisers into the shared `results`.
  async function runPass(mediaType) {
    const url = buildSearchUrl(parsed, cfg.country, mediaType);
    // reset per-pass capture state
    rawNodes.length = 0; gqlResponses = 0; gqlWithAdData = 0; gqlReadErrors = 0;

    let context = null, page = null, ready = false;
    const tried = new Set();
    const maxAttempts = cfg.maxAttempts || 12;
    for (let attempt = 1; attempt <= maxAttempts && !ready; attempt++) {
      const proxy = pickProxy(cfg.proxies, tried);
      if (proxy) tried.add(proxyKey(proxy));
      context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport: { width: 1366, height: 900 },
        locale: "en-US",
        ...(proxy ? { proxy } : {}),
      });
      await blockHeavyAssets(context);
      page = await context.newPage();
      attachInterceptor(page);

      let navOk = false;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.navTimeoutMs });
        navOk = !page.url().startsWith("chrome-error");
      } catch { /* timeout / proxy tunnel error */ }

      if (navOk) {
        await page.waitForTimeout(3000);
        const waitSec = cfg.gqlWaitSec || 30;
        for (let i = 0; i < waitSec && gqlResponses === 0; i++) await page.waitForTimeout(1000);
      }

      if (navOk && gqlResponses > 0) {
        ready = true;
      } else {
        const why = !navOk ? "page failed to load" : "search never fired (IP throttled)";
        console.log(`  [${term}] (${mediaType}) attempt ${attempt}/${maxAttempts}: ${why}${proxy ? ` via ${proxy.server}` : ""} — trying a fresh IP...`);
        await context.close().catch(() => {});
        context = null;
        gqlResponses = 0; gqlWithAdData = 0; gqlReadErrors = 0; rawNodes.length = 0;
      }
    }

    if (!ready) {
      console.log(`  [${term}] (${mediaType}) gave up after ${maxAttempts} attempts (proxy IPs couldn't load the search).`);
      if (context) await context.close().catch(() => {});
      return;
    }

    // dismiss cookie-consent if present (can block the search firing)
    try {
      const consent = page.getByRole("button", {
        name: /allow all cookies|accept all|allow essential|only allow essential|accept/i,
      });
      if (await consent.first().isVisible({ timeout: 3000 }).catch(() => false)) {
        await consent.first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }
    } catch { /* no dialog */ }

    // Scroll until Meta stops serving NEW ads (stream exhausted), not until the
    // filter stops adding rows.
    let idleScrolls = 0;
    const idleLimit = cfg.maxIdleScrolls;
    while (results.size < cfg.max && idleScrolls < idleLimit) {
      let newRaw = 0;
      for (const node of rawNodes.splice(0)) {
        const lead = normalizeAd(node);
        if (!lead.adArchiveId) continue;
        if (!seenArchive.has(lead.adArchiveId)) { seenArchive.add(lead.adArchiveId); newRaw++; }
        if (parsed.required.length && !matchesRequired(parsed.required, leadSearchText(lead))) continue;
        const key = leadKey(lead);
        if (results.has(key)) continue;
        if (seenKeys.has(key)) continue;
        results.set(key, lead);
        console.log(
          `  + [${term}] #${results.size} (${mediaType}) ${lead.companyName || "?"}` +
          ` | ${lead.website || lead.landingPage || lead.displayUrl || "no site"}`,
        );
      }
      idleScrolls = newRaw > 0 ? 0 : idleScrolls + 1;

      await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 4; i++) {
          const h = (document.body && document.body.scrollHeight)
            || document.documentElement.scrollHeight || 100000;
          window.scrollTo(0, h);
          await sleep(400);
        }
      }).catch(() => {});
      await page.waitForTimeout(cfg.scrollDelayMs);
    }

    console.log(`  [${term}] (${mediaType}) pass done — scanned ${seenArchive.size} ads total → ${results.size} unique kept`);
    await context.close().catch(() => {});
  }

  for (const mt of mediaTypes) {
    if (results.size >= cfg.max) break;
    await runPass(mt);
  }

  console.log(`  [${term}] scanned ${seenArchive.size} ads → ${results.size} unique advertiser(s) kept (media: ${mediaTypes.join("+")})`);

  // mark these as seen so other terms running later don't re-add them
  for (const key of results.keys()) seenKeys.add(key);

  return [...results.values()].slice(0, cfg.max).map((l) => ({ ...l, sourceTerm: term }));
}

// ---------------------------------------------------------------------------
// 8. OPTIONAL: LANDING-PAGE CLASSIFIER (their "confirm page type" step)
// Rules-first, cheap. This is the step that should live OUTSIDE the scraper.
// Returns one of: opt-in | vsl | booking | other | unreachable
// ---------------------------------------------------------------------------
async function classifyLandingPage(context, url) {
  if (!url) return "unreachable";
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    const signal = await page.evaluate(() => {
      const html = document.documentElement.innerHTML.toLowerCase();
      const hasVideo =
        !!document.querySelector("video, iframe[src*='youtube'], iframe[src*='vimeo'], iframe[src*='wistia']");
      const hasEmailField =
        !!document.querySelector("input[type='email'], input[name*='email' i]");
      const hasBooking =
        /calendly|acuityscheduling|youcanbook|savvycal|tidycal|book a call|schedule a call|cal\.com/.test(html) ||
        !!document.querySelector("iframe[src*='calendly'], iframe[src*='acuity'], iframe[src*='cal.com']");
      const textLen = (document.body.innerText || "").length;
      return { hasVideo, hasEmailField, hasBooking, textLen };
    });

    if (signal.hasBooking) return "booking";
    if (signal.hasVideo && signal.textLen < 1500) return "vsl";
    if (signal.hasEmailField) return "opt-in";
    return "other";
  } catch {
    return "unreachable";
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 8b. OPTIONAL: FAN-PAGE ENRICHMENT (the part you remembered)
// Visit the advertiser's Facebook page and pull the real Website, Company
// Phone, and Instagram from the public page data. Facebook embeds this in a
// JSON blob and in og/meta tags. Best-effort: returns whatever it can find and
// degrades gracefully to nulls (some pages gate this behind login).
// ---------------------------------------------------------------------------
async function enrichFromFanPage(context, fanPageUrl) {
  const out = { website: null, companyPhone: null, instagramProfile: null };
  if (!fanPageUrl) return out;
  const page = await context.newPage();
  try {
    await page.goto(fanPageUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(1500);
    const raw = await page.content();

    // Website: FB wraps EVERY outbound link (including the page's own Instagram,
    // Twitter, etc.) in l.facebook.com/l.php?u=<encoded url>. Collect them all,
    // decode, and take the first that is NOT a social/Facebook domain.
    let website = null;
    const lphpAll = [...raw.matchAll(/l\.facebook\.com\/l\.php\?u=([^"&\\]+)/g)];
    for (const m of lphpAll) {
      let url;
      try { url = decodeURIComponent(m[1]); } catch { continue; }
      if (!/^https?:\/\//.test(url)) continue;
      if (isSocialUrl(url)) continue;            // skip IG/X/YouTube/TikTok/etc.
      website = url;
      break;
    }
    if (!website) {
      const w = raw.match(/"website":"(https?:\\?\/\\?\/[^"]+)"/);
      if (w) {
        const cand = w[1].replace(/\\\//g, "/");
        if (!isSocialUrl(cand)) website = cand;
      }
    }

    // Company phone: PREFER the phone the page declares in its "phone" field
    // (works internationally, e.g. Uganda +256703380377). Only if that's missing
    // do we loosely scan text and require strict NANP validation, so we never
    // store a stray US-looking number for a non-US business.
    let companyPhone = null;
    const declared = raw.match(/"phone":"(\+?[0-9][0-9\s().-]{6,}[0-9])"/);
    if (declared) companyPhone = normalizePhone(declared[1]);
    if (!companyPhone) {
      const loose = [...raw.matchAll(/(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/g)].map((m) => m[1]);
      for (const cand of loose) {
        const valid = validUSPhone(cand);
        if (valid) { companyPhone = valid; break; }
      }
    }

    // Instagram: linked IG handle or full url.
    let instagramProfile = null;
    const ig = raw.match(/instagram\.com\\?\/([A-Za-z0-9_.]+)/);
    if (ig && ig[1] && !["p", "reel", "explore", "accounts"].includes(ig[1])) {
      instagramProfile = `https://www.instagram.com/${ig[1]}`;
    }

    out.website = website;
    out.companyPhone = companyPhone;
    out.instagramProfile = instagramProfile;
  } catch {
    // login wall / blocked — leave nulls
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

// ---------------------------------------------------------------------------
// 9. SIMPLE CONCURRENCY POOL
// ---------------------------------------------------------------------------
async function pool(items, limit, worker) {
  const results = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// 10. CLI ARG PARSING (no dependency)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--terms": args.terms = next(); break;
      case "--terms-file": args.termsFile = next(); break;
      case "--country": args.country = next(); break;
      case "--max": args.max = parseInt(next(), 10); break;
      case "--idle": args.maxIdleScrolls = parseInt(next(), 10); break;
      case "--media": args.mediaTypes = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--attempts": args.maxAttempts = parseInt(next(), 10); break;
      case "--gql-wait": args.gqlWaitSec = parseInt(next(), 10); break;
      case "--concurrency": args.concurrency = parseInt(next(), 10); break;
      case "--out": args.out = next(); break;
      case "--existing": args.existing = next(); break;
      case "--classify": args.classify = true; break;
      case "--enrich-page": args.enrichPage = true; break;
      case "--headful": args.headless = false; break;
      default: break;
    }
  }
  return args;
}

async function loadTerms(cfg) {
  if (cfg.terms) return cfg.terms.split(",").map((t) => t.trim()).filter(Boolean);
  if (cfg.termsFile) {
    const raw = await readFile(cfg.termsFile, "utf8");
    return raw.split("\n").map((t) => t.trim()).filter(Boolean);
  }
  throw new Error("Provide --terms \"a,b,c\" or --terms-file path");
}

async function loadExistingKeys(cfg) {
  const set = new Set();
  if (!cfg.existing) return set;
  try {
    const raw = JSON.parse(await readFile(cfg.existing, "utf8"));
    // accept either ["Company A", ...] or [{companyName, landingPage}, ...]
    for (const item of raw) {
      if (typeof item === "string") {
        set.add(item.toLowerCase().replace(/[^a-z0-9]/g, ""));
      } else {
        set.add(leadKey(item));
      }
    }
  } catch (e) {
    console.warn(`Could not read --existing file: ${e.message}`);
  }
  return set;
}

// ---------------------------------------------------------------------------
// 11. MAIN
// ---------------------------------------------------------------------------
async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const terms = await loadTerms(cfg);
  const seenKeys = await loadExistingKeys(cfg);

  console.log(`Scraping ${terms.length} term(s), target ${cfg.max} unique/term, ` +
    `concurrency ${cfg.concurrency}, dedup against ${seenKeys.size} existing.`);

  // Residential proxy pool. Facebook suppresses Ads Library results for
  // datacenter IPs (e.g. Render/AWS), so on a server you MUST route through
  // residential IPs. We rotate across the pool and pick a fresh one per attempt.
  cfg.proxies = loadProxies();
  if (cfg.proxies.length) {
    console.log(`Loaded ${cfg.proxies.length} proxy endpoint(s); rotating per attempt.`);
  } else {
    console.log("==================================================================");
    console.log("⚠️  NO PROXY CONFIGURED — scraping on the HOST IP. Facebook will");
    console.log("⚠️  throttle it fast and results will be heavily capped (~few hundred).");
    console.log("⚠️  Set PROXY_LIST, or drop a proxies.local.txt next to scrape-ads.js.");
    console.log("==================================================================");
  }

  // --no-sandbox is required when running as root inside a container (Render,
  // Docker, CI); Chromium otherwise refuses to launch. Harmless locally.
  // NOTE: proxy is set per-context now (see scrapeTerm), not at launch.
  const browser = await chromium.launch({
    headless: cfg.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const perTerm = await pool(terms, cfg.concurrency, async (term) => {
    const t0 = Date.now();
    const leads = await scrapeTerm(browser, term, cfg, seenKeys);
    console.log(`  [${term}] ${leads.length} leads in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return leads;
  });

  let allLeads = perTerm.flat();

  // Refine ACTIVE AD COUNT: how many ads we saw per Facebook Page across the
  // whole run. A higher count is a stronger "this advertiser is spending" signal
  // (ties to their $10K+/mo qualification). Keep any node-level count if larger.
  const adsPerPage = new Map();
  for (const l of allLeads) {
    if (!l.facebookPageId) continue;
    adsPerPage.set(l.facebookPageId, (adsPerPage.get(l.facebookPageId) || 0) + 1);
  }
  for (const l of allLeads) {
    const observed = l.facebookPageId ? adsPerPage.get(l.facebookPageId) : null;
    l.activeAdCount = Math.max(l.activeAdCount || 0, observed || 0) || null;
  }

  // optional FAN-PAGE enrichment: real Website, Company Phone, Instagram
  if (cfg.enrichPage) {
    const total = allLeads.length;
    console.log(`Enriching ${total} fan pages (website/phone/instagram)...`);
    const enrichProxy = pickProxy(cfg.proxies);
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "en-US",
      ...(enrichProxy ? { proxy: enrichProxy } : {}),
    });
    await blockHeavyAssets(ctx);
    let doneN = 0;
    await pool(allLeads, 4, async (lead) => {
      const info = await enrichFromFanPage(ctx, lead.facebookProfile);
      if (info.website) lead.website = info.website;      // prefer page's real site
      if (info.companyPhone) lead.companyPhone = info.companyPhone;
      if (info.instagramProfile) lead.instagramProfile = info.instagramProfile;
      doneN++;
      // one-by-one: log what each fan-page visit resolved
      console.log(
        `  enriched ${doneN}/${total} ${lead.companyName || "?"}` +
        ` | site=${lead.website || "-"} | phone=${lead.companyPhone || "-"} | ig=${info.instagramProfile || "-"}`,
      );
    });
    await ctx.close();
  }

  // optional landing-page classification (the "confirm page type" step)
  if (cfg.classify) {
    const total = allLeads.length;
    console.log(`Classifying ${total} landing pages...`);
    const classifyProxy = pickProxy(cfg.proxies);
    const ctx = await browser.newContext(classifyProxy ? { proxy: classifyProxy } : {});
    await blockHeavyAssets(ctx);
    let doneN = 0;
    await pool(allLeads, 5, async (lead) => {
      lead.pageType = await classifyLandingPage(ctx, lead.landingPage);
      doneN++;
      if (doneN % 10 === 0 || doneN === total) {
        console.log(`  classified ${doneN}/${total} -> ${lead.pageType}`);
      }
    });
    await ctx.close();
  }

  await browser.close();

  // TODO Step 2: enrich each lead via Apollo REST (domain first, company-name
  //   fallback — exactly the fallback Manus discovered live in your chat).
  // TODO Step 2: write to Google Sheets via the Sheets API.
  // TODO Step 3: push qualified leads to Instantly / GoHighLevel via their APIs.

  await writeFile(cfg.out, JSON.stringify(allLeads, null, 2));
  console.log(`\nDone. ${allLeads.length} unique leads written to ${cfg.out}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});