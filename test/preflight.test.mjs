// Offline tests: every API response below is synthetic. No credentials, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflightMeta, preflightLinkedIn, preflightGoogle, reconcile, redact, verdict } from '../src/index.mjs';

process.env.META_ACCESS_TOKEN = 'EAAtestmetatoken0000000000000000000000000000000000';
process.env.LINKEDIN_ACCESS_TOKEN = 'AQtestlinkedintoken00000000000000000000000000000000';
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'test-dev-token-0000';
process.env.GOOGLE_ADS_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_ADS_CLIENT_SECRET = 'test-client-secret-0000';
process.env.GOOGLE_ADS_REFRESH_TOKEN = 'test-refresh-token-0000';

/** routes: [[RegExp | (url, init) => boolean, body | (url, init) => body]] */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, body] of routes) {
      const hit = match instanceof RegExp ? match.test(String(url)) : match(String(url), init);
      if (!hit) continue;
      const b = typeof body === 'function' ? body(String(url), init) : body;
      const status = b?.__status || 200;
      return { ok: status < 400, status, url: String(url), text: async () => JSON.stringify(b) };
    }
    return { ok: false, status: 404, url: String(url), text: async () => JSON.stringify({ error: `no mock for ${url}` }) };
  };
  fn.calls = calls;
  return fn;
}
const by = (r, id) => r.findings.find((f) => f.id === id);
const LANDING = [/^https:\/\/example\.com/, {}];
const future = new Date(Date.now() + 10 * 86400000).toISOString();

// ---------- Meta ----------
const metaBase = (over = {}) => [
  [/graph\.facebook\.com\/v[\d.]+\/111\?/, { id: '111', name: 'Test', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_TRAFFIC', account_id: '999', daily_budget: '0', lifetime_budget: '0', ...over.campaign }],
  [/\/111\/adsets/, { data: over.adsets || [{ id: 's1', name: 'set', status: 'ACTIVE', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', daily_budget: '5000', lifetime_budget: '0', targeting: { geo_locations: { cities: [{ key: '100001', name: 'Springfield', region: 'Ohio', country: 'US', radius: 15, distance_unit: 'mile' }] } } }] }],
  [/\/111\/ads/, { data: over.ads || [{ id: 'a1', name: 'ad', status: 'ACTIVE', effective_status: 'ACTIVE', creative: { object_story_spec: { link_data: { link: 'https://example.com/lp' } } } }] }],
  [/\/act_999\?/, { currency: 'USD', spend_cap: over.spendCap ?? '0', amount_spent: '0' }],
  LANDING,
];

test('Meta: a clean campaign passes, and an uncapped daily budget with no end date fails', async () => {
  const r = await preflightMeta('111', { region: 'Ohio', fetchImpl: mockFetch(metaBase()) });
  for (const id of ['schedule', 'bid', 'destination', 'live', 'geo', 'landing']) assert.equal(by(r, id).status, 'PASS', `${id}: ${by(r, id).observed}`);
  assert.equal(by(r, 'spend').status, 'FAIL');
  assert.match(by(r, 'spend').observed, /\$50\.00\/day with no end date/);
});

test('Meta: "0" budgets are unset, not a $0 cap', async () => {
  const r = await preflightMeta('111', { fetchImpl: mockFetch(metaBase({ spendCap: '10000' })) });
  assert.equal(by(r, 'spend').status, 'WARN');
  assert.match(by(r, 'spend').observed, /account cap leaves \$100\.00/);
});

test('Meta: a city key that resolved to the wrong state fails geo', async () => {
  const adsets = [{ id: 's1', name: 'set', status: 'ACTIVE', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', targeting: { geo_locations: { cities: [{ key: '1', name: 'Springfield', region: 'Illinois', country: 'US' }, { key: '2', name: 'Dayton', region: 'Ohio', country: 'US' }] } } }];
  const r = await preflightMeta('111', { region: 'Ohio', fetchImpl: mockFetch(metaBase({ adsets, campaign: { stop_time: future } })) });
  assert.equal(by(r, 'geo').status, 'FAIL');
  assert.match(by(r, 'geo').observed, /Springfield, Illinois/);
  assert.doesNotMatch(by(r, 'geo').observed, /Dayton/);
});

test('Meta: a cost cap with no amount cannot bid; an ad with no link or form has no destination', async () => {
  const adsets = [{ id: 's1', name: 'capped', status: 'ACTIVE', bid_strategy: 'COST_CAP', targeting: { geo_locations: { countries: ['US'] } } }];
  const ads = [{ id: 'a1', name: 'bare video', status: 'ACTIVE', effective_status: 'ACTIVE', creative: { object_story_spec: { video_data: { video_id: 'v' } } } }];
  const r = await preflightMeta('111', { fetchImpl: mockFetch(metaBase({ adsets, ads })) });
  assert.equal(by(r, 'bid').status, 'FAIL');
  assert.equal(by(r, 'destination').status, 'FAIL');
  assert.equal(verdict(r.findings).safe, false);
});

test('Meta: an inactive lead form fails destination', async () => {
  const ads = [{ id: 'a1', name: 'lead', status: 'ACTIVE', effective_status: 'ACTIVE', creative: { object_story_spec: { video_data: { call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: '555' } } } } } }];
  const routes = [[/\/555\?/, { id: '555', name: 'form', status: 'ARCHIVED' }], ...metaBase({ ads })];
  const r = await preflightMeta('111', { fetchImpl: mockFetch(routes) });
  assert.equal(by(r, 'destination').status, 'FAIL');
  assert.match(by(r, 'destination').observed, /555 is ARCHIVED/);
});

test('Meta: tokens go in the Authorization header, never the URL', async () => {
  const f = mockFetch(metaBase());
  await preflightMeta('111', { fetchImpl: f });
  for (const c of f.calls.filter((c) => c.url.includes('graph.facebook.com'))) {
    assert.doesNotMatch(c.url, /access_token|EAAtest/);
    assert.match(c.init.headers.Authorization, /^Bearer /);
  }
});

// ---------- LinkedIn ----------
const liCampaign = (over = {}) => ({
  id: 42, name: 'Test', status: 'ACTIVE', objectiveType: 'VIDEO_VIEW', costType: 'CPM', optimizationTargetType: 'MAX_VIDEO_VIEW',
  dailyBudget: { amount: '20', currencyCode: 'USD' }, totalBudget: { amount: '300', currencyCode: 'USD' },
  targetingCriteria: { include: { and: [{ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:101'] } }] } }, ...over,
});
const liRoutes = ({ campaign = liCampaign(), creatives, post, geoName = 'Ohio, United States' } = {}) => [
  [/\/adCampaigns\/42$/, campaign],
  [/\/creatives\?q=criteria/, { elements: creatives || [{ id: 'c1', name: 'video', intendedStatus: 'ACTIVE', isServing: true, content: { reference: 'urn:li:share:1' } }] }],
  [/\/posts\//, post || { content: { media: { id: 'urn:li:video:1' } }, contentLandingPage: 'https://example.com/lp', contentCallToActionLabel: 'LEARN_MORE' }],
  [/\/geo\/101$/, { defaultLocalizedName: { value: geoName } }],
  LANDING,
];

test('LinkedIn: NONE + $0 is no bid', async () => {
  const r = await preflightLinkedIn('42', { account: '7', fetchImpl: mockFetch(liRoutes({ campaign: liCampaign({ costType: 'CPV', optimizationTargetType: 'NONE', unitCost: { amount: '0' } }) })) });
  assert.equal(by(r, 'bid').status, 'FAIL');
  assert.match(by(r, 'bid').observed, /CPV \/ NONE \/ unitCost 0/);
});

test('LinkedIn: a video post without a landing page has nowhere to go', async () => {
  const post = { content: { media: { id: 'urn:li:video:1' } } };
  const r = await preflightLinkedIn('42', { account: '7', fetchImpl: mockFetch(liRoutes({ post })) });
  assert.equal(by(r, 'destination').status, 'FAIL');
  assert.match(by(r, 'destination').observed, /no contentLandingPage and no contentCallToActionLabel/);
});

test('LinkedIn: a placeholder lead form URN fails; drafts are ignored', async () => {
  const creatives = [
    { id: 'c1', name: 'leadgen', intendedStatus: 'ACTIVE', isServing: true, leadgenCallToAction: { destination: 'REPLACE_WITH_FORM' } },
    { id: 'c2', name: 'draft', intendedStatus: 'DRAFT', isServing: false },
  ];
  const r = await preflightLinkedIn('42', { account: '7', fetchImpl: mockFetch(liRoutes({ creatives })) });
  assert.equal(by(r, 'destination').status, 'FAIL');
  assert.match(by(r, 'live').observed, /1 draft\(s\) ignored/);
});

test('LinkedIn: a whole country is wider than the region asked for; a daily budget alone is unbounded', async () => {
  const campaign = liCampaign({ totalBudget: undefined });
  const r = await preflightLinkedIn('42', { account: '7', region: 'Ohio', fetchImpl: mockFetch(liRoutes({ campaign, geoName: 'United States' })) });
  assert.equal(by(r, 'geo').status, 'FAIL');
  assert.equal(by(r, 'spend').status, 'FAIL');
});

test('LinkedIn: a finished campaign cannot serve', async () => {
  const r = await preflightLinkedIn('42', { account: '7', fetchImpl: mockFetch(liRoutes({ campaign: liCampaign({ status: 'COMPLETED' }) })) });
  assert.equal(by(r, 'schedule').status, 'FAIL');
});

// ---------- Google Ads ----------
const gRoutes = ({ campaign = {}, groups, geo } = {}) => [
  [/oauth2\.googleapis\.com/, { access_token: 'ya29.test-access-token' }],
  [(u, i) => u.includes('googleAds:search') && /FROM campaign WHERE/.test(i.body), { results: [{ customer: { currencyCode: 'USD' }, campaign: { id: '5', name: 'Search', status: 'ENABLED', servingStatus: 'SERVING', advertisingChannelType: 'SEARCH', biddingStrategyType: 'MANUAL_CPC', ...campaign }, campaignBudget: { amountMicros: '25000000' } }] }],
  [(u, i) => /FROM ad_group_ad/.test(i.body || ''), { results: [{ adGroup: { id: 'g1', status: 'ENABLED', cpcBidMicros: '0', ...groups }, adGroupAd: { status: 'ENABLED', ad: { finalUrls: ['https://example.com/lp'] }, policySummary: { approvalStatus: 'APPROVED' } } }] }],
  [(u, i) => /FROM campaign_criterion/.test(i.body || ''), { results: geo ?? [{ campaignCriterion: { location: { geoTargetConstant: 'geoTargetConstants/21167' }, negative: false } }] }],
  [(u, i) => /FROM geo_target_constant/.test(i.body || ''), { results: [{ geoTargetConstant: { canonicalName: 'Ohio,United States', targetType: 'State', countryCode: 'US' } }] }],
  LANDING,
];

test('Google: manual CPC with a $0 ad group bid cannot compete; no end date is unbounded', async () => {
  const r = await preflightGoogle('123-456-7890', '5', { region: 'Ohio', fetchImpl: mockFetch(gRoutes()) });
  assert.equal(by(r, 'bid').status, 'FAIL');
  assert.equal(by(r, 'geo').status, 'PASS');
  assert.equal(by(r, 'spend').status, 'FAIL');
});

test('Google: no location targeting fails geo', async () => {
  const r = await preflightGoogle('1234567890', '5', { fetchImpl: mockFetch(gRoutes({ groups: { cpcBidMicros: '1500000' }, geo: [] })) });
  assert.equal(by(r, 'bid').status, 'PASS');
  assert.equal(by(r, 'geo').status, 'FAIL');
});

// ---------- Reconcile ----------
test('reconcile: catches a "paused" campaign that can spend, and a spend gap', async () => {
  const f = mockFetch([
    [/\/act_1\/campaigns/, { data: [{ id: '10', name: 'Prospecting', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '4000' }, { id: '11', name: 'Old', status: 'PAUSED', effective_status: 'PAUSED' }] }],
    [/\/act_1\/insights/, { data: [{ campaign_id: '10', spend: '2000.00', impressions: '1000', clicks: '40', inline_link_clicks: '0' }, { campaign_id: '11', spend: '12.00', inline_link_clicks: '3', impressions: '10', clicks: '3' }] }],
    [/\/act_1\?/, { currency: 'USD', spend_cap: '0', amount_spent: '0' }],
  ]);
  const ledger = [{ platform: 'Meta', campaign: '10', spend: 300, status: 'paused' }, { platform: 'Meta', campaign: 'Old', spend: 12 }];
  const r = await reconcile({ meta: ['act_1'] }, { since: '2026-01-01', until: '2026-01-31', ledger, fetchImpl: f });
  assert.equal(r.canSpend.length, 1);
  assert.equal(r.discrepancies.length, 2);
  assert.ok(r.discrepancies.some((d) => Math.abs(d.gap - 1700) < 0.01));
  assert.ok(r.discrepancies.some((d) => /can spend right now/.test(d.note)));
  assert.equal(r.broken.length, 1);
  assert.deepEqual(r.uncappedMetaAccounts, ['act_1']);
});

// ---------- Redaction ----------
test('redact scrubs env credentials and token-shaped strings', () => {
  const s = `failed ${process.env.LINKEDIN_ACCESS_TOKEN} url?access_token=abc123&x=1 Bearer abcdefghijklmnop ya29.zzz 1//0abcdefghijklmnopqrstuvwxyz`;
  const out = redact(s);
  assert.doesNotMatch(out, /AQtest|abc123|abcdefghijklmnop|ya29\.zzz|1\/\/0abc/);
});
