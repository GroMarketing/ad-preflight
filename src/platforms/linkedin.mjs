import { env, getJson } from '../http.mjs';
import { FAIL, PASS, WARN, daysUntil, finding, money } from '../report.mjs';
import { checkLanding } from '../landing.mjs';

/** Active as of 2026-10; LinkedIn retires versions roughly a year after release. */
const DEFAULT_VERSION = '202609';
const HINT = 'Create a token with r_ads and r_ads_reporting (Marketing Developer Platform app) and export LINKEDIN_ACCESS_TOKEN.';

export function linkedinClient({ fetchImpl } = {}) {
  const token = env('LINKEDIN_ACCESS_TOKEN', HINT);
  const headers = {
    Authorization: `Bearer ${token}`,
    'LinkedIn-Version': process.env.LINKEDIN_API_VERSION || DEFAULT_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
  };
  // Rest.li queries carry their own syntax (List(...), (start:(...))), so paths arrive pre-built.
  const get = async (path) => {
    try {
      return await getJson('LinkedIn', `https://api.linkedin.com/rest/${path}`, { headers, fetchImpl });
    } catch (e) {
      // LinkedIn retires monthly API versions; a retired one answers 426 NONEXISTENT_VERSION.
      if (e.status === 426 || /NONEXISTENT_VERSION/.test(e.message)) {
        throw new Error(`LinkedIn API version ${headers['LinkedIn-Version']} is no longer active. Set LINKEDIN_API_VERSION to a recent month (YYYYMM), e.g. ${DEFAULT_VERSION} or newer.`);
      }
      throw e;
    }
  };
  return { get };
}

const enc = encodeURIComponent;
const amount = (m) => (m?.amount != null ? Number(m.amount) : null);

/** Bid rule, verified against serving history: auto-bid with a target, or a manual unitCost > 0. */
export function bidStatus(c) {
  const target = c.optimizationTargetType && c.optimizationTargetType !== 'NONE' ? c.optimizationTargetType : null;
  const unit = amount(c.unitCost);
  const desc = `${c.costType} / ${c.optimizationTargetType || 'NONE'} / unitCost ${unit ?? 'auto'}`;
  return { ok: Boolean(target) || unit > 0, desc };
}

/** Location URNs from targetingCriteria, include and exclude. */
function locationUrns(tc = {}) {
  const pick = (node) =>
    JSON.stringify(node || {}).match(/"urn:li:adTargetingFacet:(?:locations|profileLocations)":\[[^\]]*\]/g)?.flatMap((s) => s.match(/urn:li:geo:\d+/g) || []) || [];
  return { include: [...new Set(pick(tc.include))], exclude: [...new Set(pick(tc.exclude))] };
}

/**
 * Check every invariant on a LinkedIn campaign, reading live state.
 * opts.account is the ad account id; opts.region / opts.country: where it must serve.
 */
export async function preflightLinkedIn(campaignId, opts = {}) {
  const account = opts.account || process.env.LINKEDIN_AD_ACCOUNT_ID;
  if (!account) throw new Error('LinkedIn needs the ad account id: --account <id> or LINKEDIN_AD_ACCOUNT_ID.');
  const api = linkedinClient(opts);
  const c = await api.get(`adAccounts/${account}/adCampaigns/${campaignId}`);
  const creatives = (await api.get(`adAccounts/${account}/creatives?q=criteria&campaigns=List(${enc(`urn:li:sponsoredCampaign:${campaignId}`)})`)).elements || [];
  const cur = c.dailyBudget?.currencyCode || c.totalBudget?.currencyCode || 'USD';
  const findings = [];
  const endMs = c.runSchedule?.end;
  const over = ['COMPLETED', 'ARCHIVED', 'CANCELED', 'CANCELLED'].includes(c.status) || (endMs && endMs < Date.now());
  findings.push(over
    ? finding('schedule', FAIL, `${c.status}${endMs ? `, end ${new Date(endMs).toISOString().slice(0, 10)}` : ''}`, { why: 'This campaign has finished; it cannot serve until it is re-dated or duplicated.', fix: 'Extend runSchedule.end, or duplicate the campaign.' })
    : finding('schedule', PASS, `${c.status}${endMs ? `, ends ${new Date(endMs).toISOString().slice(0, 10)}` : ', no end date'}`));

  // 1. Bid.
  const bid = bidStatus(c);
  findings.push(
    bid.ok
      ? finding('bid', PASS, bid.desc)
      : finding('bid', FAIL, bid.desc, {
          why: 'No optimization target and no manual bid is no bid at all. It shows ACTIVE and APPROVED and serves nothing.',
          fix: 'Set an auto-bid target for the objective (e.g. MAX_LEAD, MAX_VIDEO_VIEW) or a manual unitCost above 0.',
        }),
  );

  // 2. Destination, per creative.
  // Drafts never serve, so only ACTIVE and PAUSED creatives are judged.
  const live = creatives.filter((cr) => ['ACTIVE', 'PAUSED'].includes(cr.intendedStatus));
  const drafts = creatives.filter((cr) => cr.intendedStatus === 'DRAFT').length;
  const problems = [];
  const urls = [];
  const forms = [];
  for (const cr of live) {
    const label = cr.name || cr.id;
    if (cr.leadgenCallToAction) {
      const dest = cr.leadgenCallToAction.destination || '';
      if (!/^urn:li:adForm:\d+$/.test(dest)) problems.push(`${label}: lead form destination is "${dest || 'missing'}"`);
      else forms.push(dest);
      continue;
    }
    const ref = cr.content?.reference;
    if (!ref) {
      if (!cr.content?.textAd && !cr.content?.spotlight && !cr.content?.follow) problems.push(`${label}: no content reference`);
      if (cr.content?.textAd?.landingPage) urls.push(cr.content.textAd.landingPage);
      if (cr.content?.spotlight?.landingPage) urls.push(cr.content.spotlight.landingPage);
      continue;
    }
    if (/inMailContent|conversation/i.test(ref)) continue; // InMail/conversation ads carry their own links
    let post;
    try {
      post = await api.get(`posts/${enc(ref)}`);
    } catch (e) {
      problems.push(`${label}: post unreadable (${e.status})`);
      continue;
    }
    const article = post.content?.article?.source;
    if (post.content?.media) {
      if (!post.contentLandingPage || !post.contentCallToActionLabel) {
        problems.push(`${label}: media post with ${post.contentLandingPage ? '' : 'no contentLandingPage'}${!post.contentLandingPage && !post.contentCallToActionLabel ? ' and ' : ''}${post.contentCallToActionLabel ? '' : 'no contentCallToActionLabel'}`);
      } else urls.push(post.contentLandingPage);
    } else if (article) urls.push(article);
    else if (!post.content?.multiImage && !post.content?.carousel) problems.push(`${label}: text-only post, nothing to click through to`);
  }
  if (!live.length) findings.push(finding('destination', FAIL, `no active or paused creatives${drafts ? ` (${drafts} draft)` : ''}`, { why: 'Nothing to serve.', fix: 'Attach or publish a creative.' }));
  else if (problems.length) {
    findings.push(finding('destination', FAIL, problems.join('; '), {
      why: 'Video and image posts without a landing page still serve and log clicks (profile, expand, play), but landing-page clicks stay at 0 forever. A placeholder form URN means no lead form.',
      fix: 'Set contentLandingPage and contentCallToActionLabel on the post, or a real urn:li:adForm destination for lead gen.',
    }));
  } else findings.push(finding('destination', PASS, [urls.length && `${new Set(urls).size} URL(s)`, forms.length && `lead form ${[...new Set(forms)].join(', ')}`].filter(Boolean).join('; ')));

  // 3. Creative live.
  const status = live.map((cr) => `${cr.name || cr.id}: ${cr.intendedStatus}${cr.review?.status ? `/${cr.review.status}` : ''}${cr.isServing ? ' serving' : ' not serving'}${cr.servingHoldReasons?.length ? ` (${cr.servingHoldReasons.join(', ')})` : ''}`).join('; ') + (drafts ? `; ${drafts} draft(s) ignored` : '');
  const rejected = live.filter((cr) => /REJECTED|DISAPPROVED/.test(cr.review?.status || ''));
  const activeNotServing = live.filter((cr) => cr.intendedStatus === 'ACTIVE' && !cr.isServing && c.status === 'ACTIVE');
  findings.push(
    rejected.length
      ? finding('live', FAIL, status, { why: (rejected[0].review?.rejectionReasons || []).join(', ') || 'Rejected in review.', fix: 'Fix the rejection reason and resubmit.' })
      : activeNotServing.length
        ? finding('live', FAIL, status, { why: 'The campaign is ACTIVE and the creative approved, yet it is not serving. Check the hold reasons.', fix: 'Resolve each servingHoldReason.' })
        : finding('live', PASS, status || 'n/a'),
  );

  // 4. Geo: resolve every location URN to its name.
  const { include, exclude } = locationUrns(c.targetingCriteria);
  const resolved = [];
  for (const urn of include) {
    const id = urn.split(':').pop();
    try {
      const g = await api.get(`geo/${id}`);
      resolved.push({ urn, name: g.defaultLocalizedName?.value || urn });
    } catch {
      resolved.push({ urn, name: null });
    }
  }
  const names = resolved.map((r) => r.name || `${r.urn} (unresolved)`).join('; ');
  if (!include.length) findings.push(finding('geo', FAIL, 'no location targeting', { why: 'LinkedIn requires a location; this campaign cannot serve.', fix: 'Add locations.' }));
  else if (opts.region || opts.country) {
    const want = (opts.region || opts.country).toLowerCase();
    // LinkedIn names read "City, Region, Country" or "Country"; a bare country is wider than a region.
    const wrong = resolved.filter((r) => !r.name || !r.name.toLowerCase().includes(want) || (opts.region && !r.name.includes(',')));
    findings.push(
      wrong.length
        ? finding('geo', FAIL, `outside ${opts.region || opts.country}: ${wrong.map((r) => r.name || r.urn).join('; ')}`, { why: 'Ads serve wherever the URN resolves, whatever the spec called it.', fix: 'Replace those locations.' })
        : finding('geo', PASS, `${names}${exclude.length ? `; excluding ${exclude.length}` : ''}`),
    );
  } else findings.push(finding('geo', WARN, names, { why: 'No --region/--country given, so nothing was verified. Read the list.' }));

  // 5. Spend bound. A daily budget is not a cap.
  const daily = amount(c.dailyBudget);
  const total = amount(c.totalBudget);
  const end = c.runSchedule?.end ? new Date(c.runSchedule.end).toISOString() : null;
  const days = daysUntil(end);
  findings.push(
    total != null
      ? finding('spend', PASS, `total budget ${money(total, cur)}${daily ? `, ${money(daily, cur)}/day` : ''}`)
      : days != null
        ? finding('spend', PASS, `${money(daily, cur)}/day x ${days} days to ${end.slice(0, 10)} = ${money(daily * days, cur)}`)
        : finding('spend', FAIL, `${money(daily, cur)}/day, no total budget, no end date`, { why: `Unbounded: about ${money(daily * 30, cur)} a month.`, fix: 'Set totalBudget or an end date on runSchedule.' }),
  );

  // 6. Landing page.
  findings.push(await checkLanding(urls, opts));

  return {
    platform: 'LinkedIn',
    campaign: { id: String(c.id), name: c.name, status: `${c.status}${c.servingStatuses?.length ? ` (${c.servingStatuses.join(', ')})` : ''}`, objective: c.objectiveType },
    currency: cur,
    dailySpend: daily || 0,
    findings,
  };
}

const ymd = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `(year:${y},month:${m},day:${d})`;
};

/** Campaigns that can spend, and spend over the window, for reconciliation. */
export async function linkedinSpend(accountId, { since, until, ...opts }) {
  const api = linkedinClient(opts);
  const campaigns = [];
  let start = 0;
  for (;;) {
    const page = await api.get(`adAccounts/${accountId}/adCampaigns?q=search&start=${start}&count=100`);
    campaigns.push(...(page.elements || []));
    if (!page.elements?.length || page.elements.length < 100) break;
    start += 100;
  }
  const fields = 'costInLocalCurrency,impressions,clicks,landingPageClicks,oneClickLeads,externalWebsiteConversions,pivotValues';
  const a = await api.get(`adAnalytics?q=analytics&pivot=CAMPAIGN&timeGranularity=ALL&dateRange=(start:${ymd(since)},end:${ymd(until)})&accounts=List(${enc(`urn:li:sponsoredAccount:${accountId}`)})&fields=${fields}`);
  const byId = {};
  for (const e of a.elements || []) {
    const id = String(e.pivotValues?.[0] || '').split(':').pop();
    byId[id] = e;
  }
  const rows = campaigns.map((c) => {
    const e = byId[String(c.id)] || {};
    const ended = c.runSchedule?.end && c.runSchedule.end < Date.now();
    return {
      platform: 'LinkedIn',
      account: String(accountId),
      id: String(c.id),
      name: c.name,
      status: `${c.status}${c.servingStatuses?.length ? `/${c.servingStatuses.join(',')}` : ''}`,
      canSpend: c.status === 'ACTIVE' && !ended && bidStatus(c).ok,
      dailyBudget: amount(c.dailyBudget),
      spend: Number(e.costInLocalCurrency || 0),
      impressions: Number(e.impressions || 0),
      clicks: Number(e.clicks || 0),
      linkClicks: Number(e.landingPageClicks || 0),
      leads: Number(e.oneClickLeads || 0) + Number(e.externalWebsiteConversions || 0),
    };
  });
  const cur = campaigns.find((c) => c.dailyBudget)?.dailyBudget?.currencyCode || 'USD';
  return { currency: cur, accountCap: null, rows };
}

export const _internal = { locationUrns };
