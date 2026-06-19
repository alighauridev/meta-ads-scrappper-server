/**
 * Apollo enrichment for the scraper API.
 * --------------------------------------------------------------------------
 * Same 3-step pipeline as the web app:
 *   1. Resolve the REAL company -> Apollo org (skip junk/funnel domains).
 *   2. Find a decision-maker by the resolved domain.
 *   3. /people/match -> unlock work email, personal email, and (optionally) the
 *      MOBILE PHONE.
 *
 * Phones: Apollo only returns mobile numbers ASYNCHRONOUSLY. When
 * reveal_phone_number=true you MUST pass a webhook_url; Apollo posts the phone
 * to it a few seconds–minutes later. The server hosts that webhook and hands us
 * a `phoneStore` (Map requestId -> [numbers]); after firing all matches we poll
 * that store and merge the phones in.
 */

const APOLLO_KEY = process.env.APOLLO_API_KEY || "Y3Cgva_5pRELow2hjrjGuA";
const APOLLO = "https://api.apollo.io/api/v1";

const JUNK_DOMAINS = new Set([
  "fb.me", "facebook.com", "fb.com", "m.me", "instagram.com", "linkedin.com", "lnkd.in",
  "calendly.com", "cal.com", "acuityscheduling.com", "hubspot.com", "meetings-na2.hubspot.com",
  "bit.ly", "bitly.com", "tinyurl.com", "goo.gl", "t.co", "lnk.to", "rb.gy", "cutt.ly", "shorturl.at",
  "linktr.ee", "linktree.com", "beacons.ai", "tap.bio", "msha.ke", "stan.store", "shopmy.us", "koji.to",
  "jotform.com", "form.jotform.com", "typeform.com", "gamma.site", "carrd.co",
  "zoom.us", "us02web.zoom.us", "teams.microsoft.com", "meet.google.com",
  "youtube.com", "youtu.be", "vimeo.com", "podbean.com", "spotify.com", "anchor.fm",
  "eventbrite.com", "wa.me", "t.me", "whatsapp.com", "paypal.com", "stripe.com", "venmo.com",
  "google.com", "docs.google.com", "sites.google.com", "forms.gle", "notion.site",
  "medium.com", "substack.com", "wordpress.com", "blogspot.com",
  "wixsite.com", "wix.com", "squarespace.com", "weebly.com", "godaddysites.com",
  "square.site", "strikingly.com", "mystrikingly.com", "webflow.io", "framer.website",
  "ethoslife.com", "getethos.com", "ethos.com", "ladderlife.com",
  "policygenius.com", "selectquote.com", "everquote.com", "assurance.com",
]);

const PERSON_TITLES = [
  "owner", "co-owner", "founder", "co-founder", "ceo", "chief executive officer",
  "president", "managing partner", "managing director", "managing member",
  "principal", "partner", "managing attorney", "principal attorney",
  "cfo", "chief financial officer", "chief operating officer", "coo",
];
const DM_RANK = [
  "owner", "founder", "co-founder", "ceo", "chief executive", "president",
  "managing partner", "managing director", "principal", "partner", "managing member",
  "managing attorney", "cfo", "chief financial", "coo", "chief operating",
];
function rankPerson(p) {
  const t = String(p.title || "").toLowerCase();
  for (let i = 0; i < DM_RANK.length; i++) if (t.includes(DM_RANK[i])) return i;
  return 999;
}

function hostOf(raw) {
  if (!raw) return null;
  const withProto = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try { return new URL(withProto).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; }
}
function rootDomain(host) {
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}
function usableDomain(lead) {
  for (const v of [lead.website, lead.landingPage, lead.displayUrl]) {
    if (typeof v !== "string" || !v) continue;
    const host = hostOf(v);
    if (!host) continue;
    const root = rootDomain(host);
    if (JUNK_DOMAINS.has(host) || JUNK_DOMAINS.has(root)) continue;
    return root;
  }
  return null;
}
function normName(s) {
  return (s || "").toLowerCase().replace(/&/g, " and ")
    .replace(/\b(llc|inc|pc|pa|ltd|co|corp|company|group|associates|cpa|cpas|firm|the|wealth|financial|tax|law|llp|pllc)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function nameMatch(a, b) {
  const A = new Set(normName(a).split(" ").filter((w) => w.length > 2));
  const B = new Set(normName(b).split(" ").filter((w) => w.length > 2));
  if (!A.size || !B.size) return false;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common >= 1 && common / Math.min(A.size, B.size) >= 0.5;
}

async function apolloPost(path, body) {
  const res = await fetch(`${APOLLO}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": APOLLO_KEY },
    body: JSON.stringify({ ...body, api_key: APOLLO_KEY }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apollo ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
async function apolloGet(path) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${APOLLO}${path}${sep}api_key=${APOLLO_KEY}`, {
    headers: { "Cache-Control": "no-cache", "X-Api-Key": APOLLO_KEY },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apollo GET ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
// /people/match — params in QUERY STRING. Returns { person, request_id }.
async function apolloMatch(params) {
  const qs = new URLSearchParams({ ...params, api_key: APOLLO_KEY }).toString();
  const res = await fetch(`${APOLLO}/people/match?${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": APOLLO_KEY },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apollo match -> ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRealEmail = (e) => !!e && !e.includes("*") && !e.includes("email_not_unlocked") && !e.includes("domain.com");
function pickPhone(arr = []) {
  const m = arr.find((p) => p.type === "mobile");
  if (m?.sanitized_number) return m.sanitized_number;
  return arr[0]?.sanitized_number || null;
}

// Enrich one lead. If revealPhones+webhookUrl set, fires the async phone reveal
// and returns `phoneRequestId` so the caller can merge the phone once it lands.
async function enrichLead(lead, opts = {}) {
  const companyName = lead.companyName || null;
  const domain = usableDomain(lead);
  const base = {
    ...lead,
    founderFirstName: null, founderLastName: null, founderTitle: null,
    founderEmail: null, founderPersonalEmail: null, founderPhone: null,
    founderLinkedIn: null, founderCompany: companyName, founderIndustry: null,
    founderLocation: null, apolloDomain: domain, apolloOrgId: null,
    apolloStatus: "no_person", apolloError: null,
  };

  if (!domain && !companyName) return { lead: { ...base, apolloStatus: "no_domain", apolloError: "no usable domain or company name" } };

  // Step 1 — resolve org
  let org = null;
  try {
    if (domain) {
      const q = new URLSearchParams({ domain });
      if (companyName) q.set("name", companyName);
      org = (await apolloGet(`/organizations/enrich?${q.toString()}`))?.organization || null;
    } else if (companyName) {
      const cand = (await apolloGet(`/organizations/enrich?name=${encodeURIComponent(companyName)}`))?.organization || null;
      if (cand && nameMatch(String(cand.name || ""), companyName)) org = cand;
    }
  } catch (e) {
    return { lead: { ...base, apolloStatus: "search_failed", apolloError: `org: ${e.message}` } };
  }
  if (!org || !org.id) {
    return { lead: { ...base, apolloStatus: "no_company_match", founderCompany: companyName,
      apolloError: domain ? `Apollo has no org for ${domain}` : `no name match for "${companyName}"` } };
  }
  const orgId = String(org.id);
  const industry = org.industry || null;
  const orgName = org.name || companyName;
  const orgCountry = org.country || null;
  const peopleDomain = org.primary_domain || domain || null;
  if (orgCountry && !/united states|usa|^us$/i.test(orgCountry)) {
    return { lead: { ...base, apolloStatus: "non_us", apolloOrgId: orgId, founderCompany: orgName,
      founderIndustry: industry, apolloError: `org country = ${orgCountry}` } };
  }

  await sleep(200);

  // Step 2 — find a decision-maker by domain
  let person = null;
  try {
    let people = [];
    if (peopleDomain) {
      people = (await apolloPost("/mixed_people/api_search", {
        q_organization_domains_list: [peopleDomain], person_titles: PERSON_TITLES, page: 1, per_page: 10,
      }))?.people || [];
      if (!people.length) {
        await sleep(200);
        people = (await apolloPost("/mixed_people/api_search", {
          q_organization_domains_list: [peopleDomain], page: 1, per_page: 10,
        }))?.people || [];
      }
    }
    if (!people.length) {
      await sleep(200);
      people = (await apolloPost("/mixed_people/api_search", { organization_ids: [orgId], page: 1, per_page: 10 }))?.people || [];
    }
    people.sort((a, b) => rankPerson(a) - rankPerson(b));
    person = people.find((p) => rankPerson(p) < 999 && isRealEmail(String(p.email || "")))
      || people.find((p) => rankPerson(p) < 999) || people[0] || null;
  } catch (e) {
    return { lead: { ...base, apolloStatus: "search_failed", apolloOrgId: orgId, founderCompany: orgName,
      founderIndustry: industry, apolloError: `people: ${e.message}` } };
  }
  if (!person) {
    return { lead: { ...base, apolloStatus: "no_person", apolloOrgId: orgId, founderCompany: orgName,
      founderIndustry: industry, apolloError: "no decision-maker found" } };
  }

  let firstName = person.first_name || null;
  let lastName = person.last_name || null;
  const title = person.title || null;
  let linkedin = person.linkedin_url || null;
  let phone = pickPhone(person.phone_numbers || []);
  let email = isRealEmail(String(person.email || "")) ? person.email : null;
  let personalEmail = null;
  const personId = person.id || null;
  const location = [person.city, person.state].filter(Boolean).join(", ") || null;
  let phoneRequestId = null;

  // Step 3 — match to unlock email (+ phone async)
  if (personId) {
    await sleep(200);
    try {
      const params = { id: personId, reveal_personal_emails: "true" };
      if (opts.revealPhones && opts.webhookUrl) {
        params.reveal_phone_number = "true";
        params.webhook_url = opts.webhookUrl;
      }
      const m = await apolloMatch(params);
      const matched = m?.person;
      if (m?.request_id != null) phoneRequestId = String(m.request_id);
      if (matched) {
        if (isRealEmail(String(matched.email || ""))) email = matched.email;
        const pe = Array.isArray(matched.personal_emails) ? matched.personal_emails[0] : null;
        if (pe && isRealEmail(String(pe))) personalEmail = pe;
        if (!lastName) lastName = matched.last_name || null;
        if (!linkedin) linkedin = matched.linkedin_url || null;
        if (!phone) phone = pickPhone(matched.phone_numbers || []);
      }
    } catch (e) {
      return { lead: { ...base, apolloStatus: "partial", apolloOrgId: orgId, founderFirstName: firstName,
        founderLastName: lastName, founderTitle: title, founderLinkedIn: linkedin, founderCompany: orgName,
        founderIndustry: industry, founderLocation: location, founderPhone: phone, apolloError: `match: ${e.message}` } };
    }
  }

  return {
    lead: {
      ...base,
      apolloStatus: email ? "enriched" : "partial",
      apolloOrgId: orgId,
      founderFirstName: firstName, founderLastName: lastName, founderTitle: title,
      founderEmail: email, founderPersonalEmail: personalEmail, founderPhone: phone,
      founderLinkedIn: linkedin, founderCompany: orgName, founderIndustry: industry, founderLocation: location,
    },
    phoneRequestId,
  };
}

/**
 * Enrich an array of leads. opts:
 *   revealPhones (bool), webhookUrl (string), phoneStore (Map reqId -> [numbers]),
 *   phoneWaitMs (how long to wait for async phones), onProgress(i, total).
 */
async function enrichLeads(leads, opts = {}) {
  const out = [];
  const pending = []; // { idx, requestId }
  for (let i = 0; i < leads.length; i++) {
    const { lead, phoneRequestId } = await enrichLead(leads[i], opts);
    out.push(lead);
    if (phoneRequestId && opts.revealPhones && opts.webhookUrl) pending.push({ idx: i, requestId: phoneRequestId });
    if (opts.onProgress) opts.onProgress(i + 1, leads.length);
    await sleep(150);
  }

  // Wait for Apollo to deliver phones to the webhook, then merge.
  if (pending.length && opts.phoneStore) {
    const deadline = Date.now() + (opts.phoneWaitMs || 120000);
    while (Date.now() < deadline && pending.some((p) => !opts.phoneStore.has(p.requestId))) {
      await sleep(5000);
    }
    let merged = 0;
    for (const p of pending) {
      const nums = opts.phoneStore.get(p.requestId);
      if (nums && nums.length && !out[p.idx].founderPhone) {
        out[p.idx].founderPhone = nums[0];
        merged++;
      }
    }
    console.log(`Apollo phones: merged ${merged}/${pending.length} requested (waited for webhook).`);
  }

  return out;
}

export { enrichLeads, enrichLead };
