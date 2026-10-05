import { digitsId, env, getJson, metaAccountId } from '../http.mjs';
import { FAIL, PASS, WARN, daysUntil, finding, money } from '../report.mjs';
import { checkLanding } from '../landing.mjs';

const V = () => process.env.META_API_VERSION || 'v24.0';
const HINT = 'Create a token with ads_read (Business settings > System users, or the Graph API Explorer) and export META_ACCESS_TOKEN.';

export function metaClient({ fetchImpl } = {}) {
  const token = env('META_ACCESS_TOKEN', HINT);
  const headers = { Authorization: `Bearer ${token}` };
  const get = (path, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return getJson('Meta', `https://graph.facebook.com/${V()}/${path}${q ? `?${q}` : ''}`, { headers, fetchImpl });
  };
  /** Follow `paging.next` until done. */
  const all = async (path, params) => {
    const out = [];
    let page = await get(path, { limit: '100', ...params });
    for (;;) {
      out.push(...(page.data || []));
      const next = page.paging?.next;
      if (!next) return out;
      const u = new URL(next);
      // Only follow pages back to Graph itself; the Bearer header goes with the request.
      if (u.protocol !== 'https:' || u.hostname !== 'graph.facebook.com') throw new Error(`refusing to follow paging link to ${u.hostname}`);
      u.searchParams.delete('access_token');
      page = await getJson('Meta', u.toString(), { headers, fetchImpl });
    }
  };
  return { get, all };
}

/** Meta returns money in minor units (cents) on read, and "0" for an unset budget. */
const major = (cents) => (Number(cents) > 0 ? Number(cents) / 100 : null);

const BID_NEEDS_AMOUNT = new Set(['LOWEST_COST_WITH_BID_CAP', 'COST_CAP']);

/** Every place a creative can carry its click-out URL or lead form. */
function destinations(creative = {}) {
  const s = creative.object_story_spec || {};
  const link = s.link_data || {};
  const video = s.video_data || {};
  const cta = link.call_to_action?.value || video.call_to_action?.value || {};
  const feed = creative.asset_feed_spec || {};
  const urls = [link.link, cta.link, creative.link_url, ...(feed.link_urls || []).map((l) => l.website_url)].filter(Boolean);
  return {
    urls: [...new Set(urls)],
    leadForm: cta.lead_gen_form_id || null,
    messaging: /MESSAGE|WHATSAPP/.test(link.call_to_action?.type || video.call_to_action?.type || creative.call_to_action_type || ''),
  };
}

/** Flatten targeting.geo_locations into readable places with their region. */
function places(geo = {}) {
  const out = [];
  for (const c of geo.countries || []) out.push({ kind: 'country', name: c, country: c });
  for (const r of geo.regions || []) out.push({ kind: 'region', name: r.name, region: r.name, country: r.country });
  for (const c of geo.cities || []) out.push({ kind: 'city', name: c.name, region: c.region, country: c.country, radius: c.radius ? `${c.radius} ${c.distance_unit || ''}`.trim() : null, key: c.key });
  for (const z of geo.zips || []) out.push({ kind: 'zip', name: z.name || z.key, region: z.primary_city_id ? undefined : z.region, country: z.country });
  for (const g of geo.custom_locations || []) out.push({ kind: 'pin', name: `${g.latitude},${g.longitude}`, country: g.country, radius: `${g.radius} ${g.distance_unit || ''}`.trim() });
  return out;
}

/**
 * Check every invariant on a Meta campaign, reading live state.
 * opts.region / opts.country: where it must serve (and only there).
 */
export async function preflightMeta(rawCampaignId, opts = {}) {
  const campaignId = digitsId(rawCampaignId, 'Meta campaign id');
  const api = metaClient(opts);
  const c = await api.get(campaignId, {
    fields: 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,stop_time,start_time,special_ad_categories,account_id',
  });
  const [adsets, ads, account] = await Promise.all([
    api.all(`${campaignId}/adsets`, { fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,bid_strategy,bid_amount,optimization_goal,destination_type,end_time,targeting' }),
    api.all(`${campaignId}/ads`, { fields: 'id,name,status,effective_status,issues_info,ad_review_feedback,creative{id,object_story_spec,asset_feed_spec,call_to_action_type,link_url}' }),
    api.get(metaAccountId(c.account_id), { fields: 'currency,spend_cap,amount_spent,account_status' }),
  ]);
  const cur = account.currency || 'USD';
  const findings = [];
  const ended = c.stop_time && new Date(c.stop_time) < new Date();
  findings.push(ended
    ? finding('schedule', FAIL, `ended ${c.stop_time.slice(0, 10)}`, { why: 'The end date has passed; activating does nothing until it is re-dated.', fix: 'Move the end date if it should run.' })
    : finding('schedule', PASS, `${c.start_time ? `from ${c.start_time.slice(0, 10)}` : 'no start date'}${c.stop_time ? ` to ${c.stop_time.slice(0, 10)}` : ', no end date'}`));
  const runningSets = adsets.filter((s) => s.status !== 'DELETED' && s.status !== 'ARCHIVED');
  const runningAds = ads.filter((a) => a.status !== 'DELETED' && a.status !== 'ARCHIVED');

  // 1. Bid. A cap or cost-cap strategy with no amount can't enter the auction.
  const noBid = runningSets.filter((s) => BID_NEEDS_AMOUNT.has(s.bid_strategy || c.bid_strategy) && !(Number(s.bid_amount) > 0));
  const strategies = [...new Set(runningSets.map((s) => s.bid_strategy || c.bid_strategy || 'LOWEST_COST_WITHOUT_CAP'))];
  findings.push(
    !runningSets.length
      ? finding('bid', FAIL, 'no ad sets', { why: 'A campaign without ad sets cannot serve.', fix: 'Create an ad set.' })
      : noBid.length
        ? finding('bid', FAIL, `${noBid.map((s) => `${s.name}: ${s.bid_strategy || c.bid_strategy} with no bid_amount`).join('; ')}`, {
            why: 'A bid-cap or cost-cap strategy without an amount loses every auction while showing ACTIVE.',
            fix: 'Set bid_amount, or switch to LOWEST_COST_WITHOUT_CAP.',
          })
        : finding('bid', PASS, strategies.join(', ')),
  );

  // 2. Destination.
  const noDest = [];
  const urls = [];
  const forms = new Set();
  for (const a of runningAds) {
    const d = destinations(a.creative);
    urls.push(...d.urls);
    if (d.leadForm) forms.add(d.leadForm);
    if (!d.urls.length && !d.leadForm && !d.messaging) noDest.push(a.name);
  }
  const formStatus = [];
  for (const id of forms) {
    try {
      const f = await api.get(id, { fields: 'id,name,status' });
      formStatus.push({ id, name: f.name, status: f.status });
    } catch (e) {
      formStatus.push({ id, status: `unreadable (${e.status})` });
    }
  }
  const deadForms = formStatus.filter((f) => f.status !== 'ACTIVE');
  if (!runningAds.length) findings.push(finding('destination', FAIL, 'no ads', { why: 'Nothing to serve.', fix: 'Create an ad.' }));
  else if (noDest.length) {
    findings.push(finding('destination', FAIL, `no link, lead form or message button on: ${noDest.join(', ')}`, {
      why: 'These ads can serve and collect engagement but cannot send anyone anywhere.',
      fix: 'Add a website URL with a call to action, or attach an active lead form.',
    }));
  } else if (deadForms.length) {
    findings.push(finding('destination', FAIL, `lead form ${deadForms.map((f) => `${f.id} is ${f.status}`).join(', ')}`, { why: 'The form the ad opens is not active.', fix: 'Activate the form or attach a new one.' }));
  } else {
    findings.push(finding('destination', PASS, [urls.length ? `${new Set(urls).size} URL(s)` : null, formStatus.length ? `lead form(s) ${formStatus.map((f) => `${f.name || f.id} ACTIVE`).join(', ')}` : null].filter(Boolean).join('; ') || 'messaging'));
  }

  // 3. Creative live.
  const rejected = runningAds.filter((a) => ['DISAPPROVED', 'WITH_ISSUES'].includes(a.effective_status));
  const pending = runningAds.filter((a) => ['PENDING_REVIEW', 'IN_PROCESS'].includes(a.effective_status));
  const summary = runningAds.map((a) => `${a.name}: ${a.effective_status}`).join('; ');
  findings.push(
    rejected.length
      ? finding('live', FAIL, summary, {
          why: rejected.map((a) => a.issues_info?.[0]?.error_message || JSON.stringify(a.ad_review_feedback?.global || {})).filter(Boolean).join(' | ') || 'Rejected or has delivery issues.',
          fix: 'Fix the flagged policy issue and resubmit.',
        })
      : pending.length
        ? finding('live', WARN, summary, { why: 'Still in review: approval is not yet known.' })
        : finding('live', PASS, summary || 'n/a'),
  );

  // 4. Geo. Every place must resolve inside the intended region/country.
  const allPlaces = runningSets.flatMap((s) => places(s.targeting?.geo_locations));
  const excluded = runningSets.flatMap((s) => places(s.targeting?.excluded_geo_locations));
  const placeText = [...new Set(allPlaces.map((p) => `${p.name}${p.region && p.kind !== 'region' ? `, ${p.region}` : ''}${p.country && p.kind !== 'country' ? ` (${p.country})` : ''}${p.radius ? ` +${p.radius}` : ''}`))].join('; ');
  if (!allPlaces.length) findings.push(finding('geo', WARN, 'no geo targeting found', { why: 'Meta may default to broad delivery.' }));
  else if (opts.region || opts.country) {
    const wrong = allPlaces.filter((p) => {
      if (opts.country && p.country && p.country.toUpperCase() !== opts.country.toUpperCase()) return true;
      if (!opts.region) return false;
      if (p.kind === 'country') return true; // a whole country is wider than any region
      return (p.region || '').toLowerCase() !== opts.region.toLowerCase();
    });
    findings.push(
      wrong.length
        ? finding('geo', FAIL, `outside ${opts.region || opts.country}: ${wrong.map((p) => `${p.name}${p.region ? `, ${p.region}` : ''}${p.key ? ` [key ${p.key}]` : ''}`).join('; ')}`, {
            why: 'City names collide across states; the key resolved somewhere else. Ads will serve there.',
            fix: 'Re-pick each location from the targeting search and confirm its region.',
          })
        : finding('geo', PASS, `${allPlaces.length} location(s), all in ${opts.region || opts.country}: ${placeText}${excluded.length ? `; excluding ${excluded.length}` : ''}`),
    );
  } else findings.push(finding('geo', WARN, placeText, { why: 'No --region/--country given, so nothing was verified. Read the list.' }));

  // 5. Spend bound.
  const capped = Number(account.spend_cap) > 0;
  const accountRoom = capped ? major(account.spend_cap) - major(account.amount_spent) : null;
  const daily = major(c.daily_budget) ?? runningSets.reduce((s, x) => s + (major(x.daily_budget) || 0), 0);
  const lifetime = major(c.lifetime_budget) ?? (runningSets.some((x) => major(x.lifetime_budget)) ? runningSets.reduce((s, x) => s + (major(x.lifetime_budget) || 0), 0) : null);
  const end = c.stop_time || runningSets.map((s) => s.end_time).filter(Boolean).sort().pop();
  const days = daysUntil(end);
  let exposure = lifetime;
  if (exposure == null && daily && days != null) exposure = daily * days;
  const roomText = capped ? `account cap leaves ${money(accountRoom, cur)}` : 'no account spend cap';
  findings.push(
    exposure != null
      ? finding('spend', PASS, `${lifetime != null ? `lifetime ${money(lifetime, cur)}` : `${money(daily, cur)}/day x ${days} days = ${money(exposure, cur)}`}; ${roomText}`)
      : capped
        ? finding('spend', WARN, `${money(daily, cur)}/day, no end date; ${roomText}`, { why: 'Only the account cap bounds this campaign.', fix: 'Add an end date or lifetime budget.' })
        : finding('spend', FAIL, `${money(daily, cur)}/day with no end date, no lifetime budget, ${roomText}`, {
            why: `Nothing stops it: about ${money(daily * 30, cur)} a month for as long as it is on.`,
            fix: 'Set a lifetime budget or end date, or an account spend cap. (spend_cap is written in major units but read in minor units, and setting it resets amount_spent.)',
          }),
  );

  // 6. Landing page.
  findings.push(await checkLanding(urls, opts));

  return {
    platform: 'Meta',
    campaign: { id: c.id, name: c.name, status: `${c.status} (${c.effective_status})`, objective: c.objective, specialAdCategories: c.special_ad_categories || [] },
    currency: cur,
    dailySpend: daily || 0,
    findings,
  };
}

/** Campaigns that can spend, and spend over the window, for reconciliation. */
export async function metaSpend(accountId, { since, until, ...opts }) {
  const api = metaClient(opts);
  const act = metaAccountId(accountId);
  const [campaigns, insights, account] = await Promise.all([
    api.all(`${act}/campaigns`, { fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,stop_time' }),
    api.all(`${act}/insights`, { level: 'campaign', time_range: JSON.stringify({ since, until }), fields: 'campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,actions' }),
    api.get(act, { fields: 'currency,spend_cap,amount_spent' }),
  ]);
  const byId = Object.fromEntries(insights.map((i) => [i.campaign_id, i]));
  const leadsOf = (actions = []) => actions.filter((a) => /(^|\.)lead($|_grouped)|fb_pixel_lead/.test(a.action_type)).reduce((m, a) => Math.max(m, Number(a.value)), 0);
  const rows = campaigns.map((c) => {
    const i = byId[c.id] || {};
    const isEnded = c.stop_time && new Date(c.stop_time) < new Date();
    return {
      platform: 'Meta',
      account: act,
      id: c.id,
      name: c.name,
      status: `${c.status}/${c.effective_status}`,
      canSpend: c.effective_status === 'ACTIVE' && !isEnded,
      dailyBudget: major(c.daily_budget),
      spend: Number(i.spend || 0),
      impressions: Number(i.impressions || 0),
      clicks: Number(i.clicks || 0),
      linkClicks: Number(i.inline_link_clicks || 0),
      leads: leadsOf(i.actions),
    };
  });
  // Spend on campaigns since deleted still shows in insights; keep it.
  for (const i of insights) if (!campaigns.find((c) => c.id === i.campaign_id)) rows.push({ platform: 'Meta', account: act, id: i.campaign_id, name: i.campaign_name, status: 'not listed', canSpend: false, spend: Number(i.spend || 0), impressions: Number(i.impressions || 0), clicks: Number(i.clicks || 0), linkClicks: Number(i.inline_link_clicks || 0), leads: leadsOf(i.actions) });
  return { currency: account.currency || 'USD', accountCap: Number(account.spend_cap) > 0 ? major(account.spend_cap) : null, rows };
}

export const _internal = { destinations, places };
