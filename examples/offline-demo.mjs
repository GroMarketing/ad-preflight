#!/usr/bin/env node
// Runs a real preflight against a fake, broken LinkedIn campaign: no credentials, no network.
//   node examples/offline-demo.mjs
import { preflightLinkedIn, formatReport } from '../src/index.mjs';

process.env.LINKEDIN_ACCESS_TOKEN ||= 'demo-token-not-real';
const DAY = 86400000;
const responses = [
  [/\/adCampaigns\/123456789$/, {
    id: 123456789, name: 'Q3 webinar - video', status: 'ACTIVE', objectiveType: 'VIDEO_VIEW',
    costType: 'CPV', optimizationTargetType: 'NONE', unitCost: { amount: '0', currencyCode: 'USD' },
    dailyBudget: { amount: '50', currencyCode: 'USD' }, totalBudget: { amount: '1500', currencyCode: 'USD' },
    runSchedule: { start: Date.now() - DAY, end: Date.now() + 40 * DAY },
    targetingCriteria: { include: { and: [{ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:90000001'] } }] } },
  }],
  [/\/creatives\?q=criteria/, { elements: [{ id: 'c1', name: 'webinar_15s', intendedStatus: 'ACTIVE', isServing: true, content: { reference: 'urn:li:ugcPost:1' } }] }],
  // A video post with no landing page and no call to action: it serves, and sends nobody anywhere.
  [/\/posts\//, { content: { media: { id: 'urn:li:video:1' } } }],
  [/\/geo\/90000001$/, { defaultLocalizedName: { value: 'Columbus, Ohio, United States' } }],
];
const fetchImpl = async (url) => {
  const hit = responses.find(([re]) => re.test(url));
  return { ok: Boolean(hit), status: hit ? 200 : 404, url, text: async () => JSON.stringify(hit ? hit[1] : {}) };
};

const report = await preflightLinkedIn('123456789', { account: '500000000', region: 'Ohio', fetchImpl });
console.log(formatReport(report));
