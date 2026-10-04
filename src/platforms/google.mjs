import { env, getJson } from '../http.mjs';
import { FAIL, PASS, WARN, daysUntil, finding, money } from '../report.mjs';
import { checkLanding } from '../landing.mjs';

const HINT = 'Set GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and GOOGLE_ADS_REFRESH_TOKEN (optional GOOGLE_ADS_LOGIN_CUSTOMER_ID for a manager account).';
const digits = (s) => String(s || '').replace(/\D/g, '');
const micros = (m) => (m == null ? null : Number(m) / 1e6);

export function googleClient({ fetchImpl } = {}) {
  const V = process.env.GOOGLE_ADS_API_VERSION || 'v25';
  const dev = env('GOOGLE_ADS_DEVELOPER_TOKEN', HINT);
  let access;
  const token = async () => {
    if (access) return access;
    const j = await getJson('Google OAuth', 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      fetchImpl,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env('GOOGLE_ADS_CLIENT_ID', HINT),
        client_secret: env('GOOGLE_ADS_CLIENT_SECRET', HINT),
        refresh_token: env('GOOGLE_ADS_REFRESH_TOKEN', HINT),
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!j.access_token) throw new Error('Google OAuth returned no access token; check the client and refresh token.');
    return (access = j.access_token);
  };
  /** GAQL search, all pages. */
  const query = async (customerId, gaql) => {
    const cid = digits(customerId);
    const login = digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
    const headers = { Authorization: `Bearer ${await token()}`, 'developer-token': dev, 'Content-Type': 'application/json', ...(login ? { 'login-customer-id': login } : {}) };
    const rows = [];
    let pageToken;
    do {
      const j = await getJson('Google Ads', `https://googleads.googleapis.com/${V}/customers/${cid}/googleAds:search`, {
        method: 'POST',
        headers,
        fetchImpl,
        body: JSON.stringify({ query: gaql, ...(pageToken ? { pageToken } : {}) }),
      });
      rows.push(...(j.results || []));
      pageToken = j.nextPageToken;
    } while (pageToken);
    return rows;
  };
  return { query };
}

/** Strategies that need a bid or target on the campaign or ad group to compete. */
function bidProblem(c, groups) {
  const t = c.biddingStrategyType;
  if (t === 'MANUAL_CPC' || t === 'MANUAL_CPM' || t === 'MANUAL_CPV') {
    const key = { MANUAL_CPC: 'cpcBidMicros', MANUAL_CPM: 'cpmBidMicros', MANUAL_CPV: 'cpvBidMicros' }[t];
    const zero = groups.filter((g) => g.status === 'ENABLED' && !(Number(g[key]) > 0));
    if (zero.length) return `${t} with no bid on ${zero.length} enabled ad group(s)`;
  }
  if (t === 'TARGET_CPA' && !(Number(c.targetCpa?.targetCpaMicros) > 0)) return 'TARGET_CPA with no target';
  if (t === 'TARGET_ROAS' && !(Number(c.targetRoas?.targetRoas) > 0)) return 'TARGET_ROAS with no target';
  return null;
}

/**
 * Check every invariant on a Google Ads campaign, reading live state.
 * opts.region / opts.country: where it must serve (matched against the geo target's canonical name).
 */
export async function preflightGoogle(customerId, campaignId, opts = {}) {
  const api = googleClient(opts);
  const id = digits(campaignId);
  const [base] = await api.query(customerId, `SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.advertising_channel_type,
    campaign.bidding_strategy_type, campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas, campaign.end_date_time,
    campaign_budget.amount_micros, campaign_budget.total_amount_micros, customer.currency_code FROM campaign WHERE campaign.id = ${id}`);
  if (!base) throw new Error(`campaign ${id} not found on customer ${digits(customerId)} (check the customer id and GOOGLE_ADS_LOGIN_CUSTOMER_ID)`);
  const c = base.campaign;
  const cur = base.customer?.currencyCode || 'USD';
  const [ads, geo] = await Promise.all([
    api.query(customerId, `SELECT ad_group.id, ad_group.status, ad_group.cpc_bid_micros, ad_group.cpm_bid_micros, ad_group.cpv_bid_micros,
      ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.policy_summary.approval_status,
      ad_group_ad.policy_summary.review_status FROM ad_group_ad WHERE campaign.id = ${id} AND ad_group_ad.status != 'REMOVED'`),
    api.query(customerId, `SELECT campaign_criterion.location.geo_target_constant, campaign_criterion.negative
      FROM campaign_criterion WHERE campaign.id = ${id} AND campaign_criterion.type = 'LOCATION'`),
  ]);
  const findings = [];
  const endIso = c.endDateTime ? new Date(c.endDateTime.replace(' ', 'T')).toISOString() : null;
  const over = c.servingStatus === 'ENDED' || (endIso && new Date(endIso) < new Date());
  findings.push(over
    ? finding('schedule', FAIL, `serving status ${c.servingStatus}${endIso ? `, end ${endIso.slice(0, 10)}` : ''}`, { why: 'The end date has passed; enabling it does nothing until it is re-dated.', fix: 'Move the end date if it should run.' })
    : finding('schedule', PASS, `serving status ${c.servingStatus}${endIso ? `, ends ${endIso.slice(0, 10)}` : ', no end date'}`));
  const groups = [...new Map(ads.map((r) => [r.adGroup.id, r.adGroup])).values()];

  // 1. Bid.
  const problem = bidProblem(c, groups);
  findings.push(problem ? finding('bid', FAIL, problem, { why: 'Without a bid or target the campaign cannot compete in the auction.', fix: 'Set the bid or target, or switch to Maximize clicks/conversions.' }) : finding('bid', PASS, c.biddingStrategyType));

  // 2 + 3. Destination and approval, per enabled ad.
  const enabled = ads.filter((r) => r.adGroupAd.status === 'ENABLED' && r.adGroup.status === 'ENABLED');
  const urls = enabled.flatMap((r) => r.adGroupAd.ad.finalUrls || []);
  const noUrl = enabled.filter((r) => !(r.adGroupAd.ad.finalUrls || []).length);
  const shopping = /SHOPPING|PERFORMANCE_MAX|SMART|APP/.test(c.advertisingChannelType);
  if (!enabled.length) findings.push(finding('destination', FAIL, 'no enabled ads in enabled ad groups', { why: 'Nothing to serve.', fix: 'Enable an ad.' }));
  else if (noUrl.length && !shopping) findings.push(finding('destination', FAIL, `${noUrl.length} enabled ad(s) without a final URL`, { why: 'Those ads have nowhere to send a click.', fix: 'Set final URLs.' }));
  else findings.push(finding('destination', PASS, `${new Set(urls).size} final URL(s)${shopping ? ` (${c.advertisingChannelType} also uses feed/asset URLs)` : ''}`));

  const disapproved = enabled.filter((r) => /DISAPPROVED/.test(r.adGroupAd.policySummary?.approvalStatus || ''));
  const limited = enabled.filter((r) => r.adGroupAd.policySummary?.approvalStatus === 'APPROVED_LIMITED');
  const pending = enabled.filter((r) => /REVIEW_IN_PROGRESS|UNDER_APPEAL/.test(r.adGroupAd.policySummary?.reviewStatus || ''));
  const tally = Object.entries(enabled.reduce((m, r) => ((m[r.adGroupAd.policySummary?.approvalStatus || 'UNKNOWN'] = (m[r.adGroupAd.policySummary?.approvalStatus || 'UNKNOWN'] || 0) + 1), m), {})).map(([k, v]) => `${v} ${k}`).join(', ');
  findings.push(
    disapproved.length === enabled.length && enabled.length
      ? finding('live', FAIL, tally, { why: 'Every enabled ad is disapproved.', fix: 'Fix the policy issue and request review.' })
      : disapproved.length || limited.length || pending.length
        ? finding('live', WARN, `${tally}${pending.length ? `, ${pending.length} in review` : ''}`, { why: 'Some ads are disapproved, limited or still in review.' })
        : finding('live', PASS, `${tally || 'n/a'}; serving status ${c.servingStatus}`),
  );

  // 4. Geo.
  const targets = geo.filter((g) => !g.campaignCriterion.negative).map((g) => g.campaignCriterion.location.geoTargetConstant);
  let named = [];
  if (targets.length) {
    const list = targets.map((t) => `'${t}'`).join(',');
    named = await api.query(customerId, `SELECT geo_target_constant.resource_name, geo_target_constant.canonical_name, geo_target_constant.target_type, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${list})`);
  }
  const places = named.map((n) => n.geoTargetConstant);
  const desc = places.map((p) => `${p.canonicalName} (${p.targetType})`).join('; ');
  if (!targets.length) findings.push(finding('geo', FAIL, 'no location targeting: serves in every country the campaign language allows', { why: 'Untargeted search campaigns spend worldwide.', fix: 'Add locations.' }));
  else if (opts.region || opts.country) {
    const wrong = places.filter((p) => {
      if (opts.country && p.countryCode?.toUpperCase() !== opts.country.toUpperCase()) return true;
      if (!opts.region) return false;
      if (p.targetType === 'Country') return true;
      return !p.canonicalName.toLowerCase().split(',').map((s) => s.trim()).includes(opts.region.toLowerCase());
    });
    findings.push(wrong.length ? finding('geo', FAIL, `outside ${opts.region || opts.country}: ${wrong.map((p) => p.canonicalName).join('; ')}`, { why: 'Those locations sit outside the intended area.', fix: 'Remove or replace them.' }) : finding('geo', PASS, desc));
  } else findings.push(finding('geo', WARN, desc, { why: 'No --region/--country given, so nothing was verified. Read the list.' }));

  // 5. Spend bound.
  const daily = micros(base.campaignBudget?.amountMicros);
  const total = micros(base.campaignBudget?.totalAmountMicros);
  const end = c.endDateTime ? new Date(c.endDateTime.replace(' ', 'T')).toISOString() : null;
  const days = daysUntil(end);
  findings.push(
    total
      ? finding('spend', PASS, `total budget ${money(total, cur)}`)
      : days != null
        ? finding('spend', PASS, `${money(daily, cur)}/day x ${days} days to ${end.slice(0, 10)} = ${money(daily * days, cur)}`)
        : finding('spend', FAIL, `${money(daily, cur)}/day, no end date, no total budget`, {
            why: `Unbounded: Google may spend up to 2x the daily budget on a given day, about ${money(daily * 30.4, cur)} a month.`,
            fix: 'Set an end date. Pausing is one boolean; a past end date (serving status ENDED) needs a second deliberate act to undo.',
          }),
  );

  // 6. Landing page.
  findings.push(await checkLanding(urls, opts));

  return {
    platform: 'Google Ads',
    campaign: { id: c.id, name: c.name, status: `${c.status} (${c.servingStatus})`, objective: c.advertisingChannelType },
    currency: cur,
    dailySpend: daily || 0,
    findings,
  };
}

/** Campaigns that can spend, and spend over the window, for reconciliation. */
export async function googleSpend(customerId, { since, until, ...opts }) {
  const api = googleClient(opts);
  const [list, metrics] = await Promise.all([
    api.query(customerId, `SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign_budget.amount_micros, customer.currency_code FROM campaign WHERE campaign.status != 'REMOVED'`),
    api.query(customerId, `SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`),
  ]);
  const m = {};
  for (const r of metrics) {
    const x = (m[r.campaign.id] ||= { cost: 0, impressions: 0, clicks: 0, conversions: 0, name: r.campaign.name });
    x.cost += micros(r.metrics.costMicros) || 0;
    x.impressions += Number(r.metrics.impressions || 0);
    x.clicks += Number(r.metrics.clicks || 0);
    x.conversions += Number(r.metrics.conversions || 0);
  }
  const rows = list.map((r) => {
    const x = m[r.campaign.id] || {};
    return {
      platform: 'Google Ads',
      account: digits(customerId),
      id: r.campaign.id,
      name: r.campaign.name,
      status: `${r.campaign.status}/${r.campaign.servingStatus}`,
      // PAUSED is one boolean away from spending, so only ENDED/REMOVED count as dark.
      canSpend: r.campaign.status === 'ENABLED' && !/ENDED|SUSPENDED/.test(r.campaign.servingStatus),
      armed: r.campaign.status === 'PAUSED' && r.campaign.servingStatus === 'SERVING',
      dailyBudget: micros(r.campaignBudget?.amountMicros),
      spend: x.cost || 0,
      impressions: x.impressions || 0,
      clicks: x.clicks || 0,
      linkClicks: x.clicks || 0,
      leads: x.conversions || 0,
    };
  });
  return { currency: list[0]?.customer?.currencyCode || 'USD', accountCap: null, rows };
}
