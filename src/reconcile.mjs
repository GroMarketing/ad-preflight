import fs from 'node:fs';
import { metaSpend } from './platforms/meta.mjs';
import { linkedinSpend } from './platforms/linkedin.mjs';
import { googleSpend } from './platforms/google.mjs';
import { money } from './report.mjs';

const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Pull every campaign and its real spend from each account, then compare with
 * a ledger of what your records claim. "We paused it" is a hypothesis; the
 * platform settles it.
 *
 * accounts: { meta: [...], linkedin: [...], google: [...] }
 * ledger: [{ platform, campaign (id or name), spend?, status? ('paused'|'active'|'ended') }]
 */
export async function reconcile(accounts, { days = 30, since, until, ledger = [], ...opts } = {}) {
  const end = until || iso(new Date());
  const start = since || iso(new Date(Date.now() - (days - 1) * 86400000));
  const jobs = [
    ...(accounts.meta || []).map((a) => metaSpend(a, { since: start, until: end, ...opts })),
    ...(accounts.linkedin || []).map((a) => linkedinSpend(a, { since: start, until: end, ...opts })),
    ...(accounts.google || []).map((a) => googleSpend(a, { since: start, until: end, ...opts })),
  ];
  const results = await Promise.all(jobs);
  const rows = results.flatMap((r) => r.rows.map((x) => ({ ...x, currency: r.currency })));
  const uncapped = results.flatMap((r) => (r.accountCap == null && r.rows[0]?.platform === 'Meta' ? [r.rows[0].account] : [])).filter(Boolean);

  const canSpend = rows.filter((r) => r.canSpend);
  const armed = rows.filter((r) => r.armed);
  const broken = rows.filter((r) => r.spend > 0 && r.linkClicks === 0 && r.leads === 0);

  const discrepancies = [];
  for (const claim of ledger) {
    const key = String(claim.campaign);
    const match = rows.filter((r) => (!claim.platform || r.platform.toLowerCase().startsWith(String(claim.platform).toLowerCase())) && (r.id === key || r.name === key));
    if (!match.length) {
      discrepancies.push({ claim, platform: null, gap: null, note: 'not found on any account checked' });
      continue;
    }
    const spent = match.reduce((s, r) => s + r.spend, 0);
    if (claim.spend != null) {
      const gap = spent - Number(claim.spend);
      if (Math.abs(gap) > Math.max(1, 0.02 * Math.max(spent, Number(claim.spend)))) {
        discrepancies.push({ claim, platform: spent, gap, note: `record says ${money(claim.spend)}, platform says ${money(spent)}` });
      }
    }
    const status = String(claim.status || '').toLowerCase();
    if (/paused|ended|off|stopped/.test(status) && match.some((r) => r.canSpend)) {
      discrepancies.push({ claim, platform: spent, gap: null, note: `record says ${claim.status}, but it can spend right now (${match.map((r) => r.status).join(', ')})` });
    }
  }
  // Anything live that the ledger doesn't know about is drift.
  const known = new Set(ledger.map((l) => String(l.campaign)));
  const drift = ledger.length ? canSpend.filter((r) => !known.has(r.id) && !known.has(r.name)) : [];

  const totals = {};
  for (const r of rows) totals[r.currency] = (totals[r.currency] || 0) + r.spend;
  return { since: start, until: end, ledgerGiven: ledger.length > 0, rows, totals, canSpend, armed, broken, discrepancies, drift, uncappedMetaAccounts: uncapped };
}

export function loadLedger(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const arr = Array.isArray(j) ? j : j.campaigns;
  if (!Array.isArray(arr)) throw new Error(`${file}: expected an array of { platform, campaign, spend?, status? }`);
  return arr;
}

export function formatReconcile(r) {
  const out = [];
  const total = Object.entries(r.totals).map(([c, v]) => money(v, c)).join(' + ') || '$0.00';
  out.push(`${r.canSpend.length} campaign(s) can spend right now. ${total} spent ${r.since} to ${r.until}.`, '');
  const byPlatform = {};
  for (const x of r.rows) (byPlatform[x.platform] ||= []).push(x);
  for (const [p, rows] of Object.entries(byPlatform)) {
    out.push(p);
    for (const x of rows.filter((x) => x.spend > 0 || x.canSpend || x.armed).sort((a, b) => b.spend - a.spend)) {
      const cpl = x.leads ? money(x.spend / x.leads, x.currency) : 'no leads';
      const cpc = x.linkClicks ? money(x.spend / x.linkClicks, x.currency) : 'no clicks';
      out.push(`  ${x.canSpend ? 'LIVE ' : x.armed ? 'ARMED' : '     '} ${money(x.spend, x.currency).padStart(10)}  ${x.name} [${x.id}] ${x.status}  ${x.linkClicks} link clicks (${cpc}), ${x.leads} leads (${cpl})`);
    }
    const quiet = rows.filter((x) => !(x.spend > 0 || x.canSpend || x.armed)).length;
    if (quiet) out.push(`  ...and ${quiet} campaign(s) with no spend that cannot spend`);
    out.push('');
  }
  out.push('Discrepancies');
  if (!r.ledgerGiven) out.push('  no ledger given (--ledger), so there was nothing to check the platforms against');
  else if (!r.discrepancies.length) out.push('  none: every claim in the ledger matches the platforms');
  for (const d of r.discrepancies) out.push(`  ${d.claim.platform || ''} ${d.claim.campaign}: ${d.note}${d.gap != null ? ` (gap ${money(d.gap)})` : ''}`);
  out.push('', 'Drift');
  const driftLines = [
    ...r.drift.map((x) => `  live but not in the ledger: ${x.platform} ${x.name} [${x.id}]`),
    ...r.armed.map((x) => `  paused but still SERVING, one switch from spending ${money(x.dailyBudget, x.currency)}/day: ${x.name} [${x.id}] (set an end date to make it ENDED)`),
    ...r.uncappedMetaAccounts.map((a) => `  Meta account ${a} has no account spend cap`),
    ...r.broken.map((x) => `  spent ${money(x.spend, x.currency)} for 0 link clicks and 0 leads, usually a structural break, not the copy (run preflight): ${x.platform} ${x.name} [${x.id}]`),
  ];
  out.push(...(driftLines.length ? driftLines : ['  none found']));
  return out.join('\n');
}
