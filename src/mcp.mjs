import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { preflightMeta } from './platforms/meta.mjs';
import { preflightLinkedIn } from './platforms/linkedin.mjs';
import { preflightGoogle } from './platforms/google.mjs';
import { reconcile, formatReconcile } from './reconcile.mjs';
import { formatReport, verdict } from './report.mjs';
import { redact } from './http.mjs';

const { version } = createRequire(import.meta.url)('../package.json');

// Every tool is read-only; nothing here can activate, pause or edit a campaign.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const run = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return { ...text(redact(e.message || String(e))), isError: true };
  }
};
const preflightResult = (r) => ({
  ...text(formatReport(r)),
  structuredContent: { ...r, verdict: verdict(r.findings) },
});

const geo = {
  region: z.string().optional().describe('Region/state the campaign must serve in, and only there, e.g. "Ohio"'),
  country: z.string().optional().describe('Country it must serve in: a 2-letter code for Meta/Google, a name for LinkedIn'),
};

export async function startServer() {
  const server = new McpServer({ name: 'ad-preflight', version });

  server.registerTool(
    'preflight_meta_campaign',
    {
      title: 'Preflight a Meta (Facebook/Instagram) campaign',
      description: 'Read live state and check that a Meta campaign can win auctions, has a click destination or an active lead form, is approved, targets only the intended geo, has a spend bound, and lands on a working page. Use before activating and after any edit.',
      inputSchema: { campaign_id: z.string(), ...geo },
      annotations: READ_ONLY,
    },
    run(async ({ campaign_id, region, country }) => preflightResult(await preflightMeta(campaign_id, { region, country }))),
  );

  server.registerTool(
    'preflight_linkedin_campaign',
    {
      title: 'Preflight a LinkedIn campaign',
      description: 'Read live state and check that a LinkedIn campaign has a real bid (not NONE + $0), that video/image posts carry a landing page and CTA or that lead-gen creatives point at a real form, that creatives are serving, that geo resolves where intended, and that spend is bounded.',
      inputSchema: { campaign_id: z.string(), account_id: z.string().optional().describe('Ad account id (defaults to LINKEDIN_AD_ACCOUNT_ID)'), ...geo },
      annotations: READ_ONLY,
    },
    run(async ({ campaign_id, account_id, region, country }) => preflightResult(await preflightLinkedIn(campaign_id, { account: account_id, region, country }))),
  );

  server.registerTool(
    'preflight_google_ads_campaign',
    {
      title: 'Preflight a Google Ads campaign',
      description: 'Read live state and check bids/targets, final URLs, ad approval, location targets, budget bounds (end date or total budget) and landing pages for a Google Ads campaign.',
      inputSchema: { customer_id: z.string(), campaign_id: z.string(), ...geo },
      annotations: READ_ONLY,
    },
    run(async ({ customer_id, campaign_id, region, country }) => preflightResult(await preflightGoogle(customer_id, campaign_id, { region, country }))),
  );

  server.registerTool(
    'reconcile_ad_spend',
    {
      title: 'Reconcile ad spend across platforms',
      description: 'Pull real spend per campaign from Meta, LinkedIn and Google Ads, list what can spend right now (including paused campaigns still one switch from serving), and compare against claimed spend/status. Use before quoting any spend or CAC figure.',
      inputSchema: {
        meta_accounts: z.array(z.string()).optional(),
        linkedin_accounts: z.array(z.string()).optional(),
        google_customers: z.array(z.string()).optional(),
        days: z.number().int().min(1).max(365).optional(),
        ledger: z.array(z.object({ platform: z.string().optional(), campaign: z.string(), spend: z.number().optional(), status: z.string().optional() })).optional().describe('What your records claim, to check against the platforms'),
      },
      annotations: READ_ONLY,
    },
    run(async ({ meta_accounts = [], linkedin_accounts = [], google_customers = [], days = 30, ledger = [] }) => {
      const r = await reconcile({ meta: meta_accounts, linkedin: linkedin_accounts, google: google_customers }, { days, ledger });
      return { ...text(formatReconcile(r)), structuredContent: r };
    }),
  );

  await server.connect(new StdioServerTransport());
}
