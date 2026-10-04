#!/usr/bin/env node
import { preflightMeta } from '../src/platforms/meta.mjs';
import { preflightLinkedIn } from '../src/platforms/linkedin.mjs';
import { preflightGoogle } from '../src/platforms/google.mjs';
import { reconcile, loadLedger, formatReconcile } from '../src/reconcile.mjs';
import { formatReport, verdict } from '../src/report.mjs';
import { redact } from '../src/http.mjs';

const HELP = `ad-preflight: can this campaign actually serve, and if it serves, can it convert?
Read-only. It never activates, pauses or edits anything.

  ad-preflight meta <campaign_id>                      [--region <name>] [--country <CC>] [--json]
  ad-preflight linkedin <campaign_id> --account <id>   [--region <name>] [--country <name>] [--json]
  ad-preflight google <customer_id> <campaign_id>      [--region <name>] [--country <CC>] [--json]

      Checks: a valid bid, a click destination or real lead form, approval and
      serving, geo resolved to the place you meant, a spend bound, a working
      landing page. Exit 0 = SAFE TO ACTIVATE, 1 = DO NOT ACTIVATE, 2 = error.

  ad-preflight spend [--meta <act_id>]... [--linkedin <account_id>]... [--google <customer_id>]...
                     [--days 30 | --since YYYY-MM-DD --until YYYY-MM-DD] [--ledger ledger.json] [--json]

      Real spend per campaign from each platform, what can spend right now, and
      every place your ledger disagrees with the platform. Exit 1 on a discrepancy.

  ad-preflight mcp     Run as an MCP server (stdio) for Claude Code, Cursor and others.

Credentials come from the environment only (see README):
  META_ACCESS_TOKEN · LINKEDIN_ACCESS_TOKEN · GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID,
  GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN [, GOOGLE_ADS_LOGIN_CUSTOMER_ID]`;

const argv = process.argv.slice(2);
const cmd = argv.shift();
const MULTI = new Set(['meta', 'linkedin', 'google']);
const VALUED = new Set(['account', 'region', 'country', 'days', 'since', 'until', 'ledger', ...MULTI]);
const opt = { meta: [], linkedin: [], google: [] };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { pos.push(a); continue; }
  const k = a.slice(2);
  if (!VALUED.has(k)) { opt[k] = true; continue; }
  const v = argv[++i];
  if (MULTI.has(k)) opt[k].push(v);
  else opt[k] = v;
}
const geo = { region: opt.region, country: opt.country };

async function main() {
  if (cmd === 'mcp') {
    const { startServer } = await import('../src/mcp.mjs');
    return startServer();
  }
  let report;
  if (cmd === 'meta' && pos[0]) report = await preflightMeta(pos[0], geo);
  else if (cmd === 'linkedin' && pos[0]) report = await preflightLinkedIn(pos[0], { ...geo, account: opt.account });
  else if (cmd === 'google' && pos[1]) report = await preflightGoogle(pos[0], pos[1], geo);
  else if (cmd === 'spend') {
    if (!opt.meta.length && !opt.linkedin.length && !opt.google.length) { console.error('spend needs at least one --meta, --linkedin or --google account.'); process.exit(2); }
    const r = await reconcile({ meta: opt.meta, linkedin: opt.linkedin, google: opt.google }, {
      days: Number(opt.days || 30), since: opt.since, until: opt.until, ledger: opt.ledger ? loadLedger(opt.ledger) : [],
    });
    console.log(opt.json ? JSON.stringify(r, null, 2) : formatReconcile(r));
    process.exit(r.discrepancies.length ? 1 : 0);
  } else {
    console.log(HELP);
    process.exit(cmd && !['-h', '--help', 'help'].includes(cmd) ? 2 : 0);
  }
  console.log(opt.json ? JSON.stringify({ ...report, verdict: verdict(report.findings) }, null, 2) : formatReport(report));
  process.exit(verdict(report.findings).safe ? 0 : 1);
}

main().catch((e) => {
  console.error(redact(e.message || e));
  process.exit(2);
});
