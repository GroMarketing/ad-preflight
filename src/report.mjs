/**
 * Every check returns a finding with the value actually observed on the
 * platform. "Looks fine" is not a result; the observed value is.
 */

export const PASS = 'PASS';
export const FAIL = 'FAIL';
export const WARN = 'WARN';
export const SKIP = 'SKIP';

export const finding = (id, status, observed, { why = '', fix = '' } = {}) => ({ id, status, observed, why, fix });

export const CHECKS = {
  schedule: 'Schedule lets it serve',
  bid: 'Can win an auction',
  destination: 'Has somewhere to send people',
  live: 'Creative is approved and serving',
  geo: 'Geo resolves to the intended place',
  spend: 'Spend is bounded',
  landing: 'Landing page works',
};

/** SAFE when nothing failed. WARN never blocks, but it is always shown. */
export function verdict(findings) {
  const blocking = findings.filter((f) => f.status === FAIL);
  return { safe: blocking.length === 0, blocking };
}

export const money = (n, cur = 'USD') => (n == null || Number.isNaN(n) ? 'n/a' : `${cur === 'USD' ? '$' : ''}${Number(n).toFixed(2)}${cur === 'USD' ? '' : ` ${cur}`}`);

export const daysUntil = (iso, now = Date.now()) => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 86400000)) : null);

/** Human report. Failures first: lead with what costs money. */
export function formatReport(r) {
  const order = { FAIL: 0, WARN: 1, PASS: 2, SKIP: 3 };
  const rows = [...r.findings].sort((a, b) => order[a.status] - order[b.status]);
  const out = [`${r.platform} campaign ${r.campaign.id}  "${r.campaign.name}"`, `status: ${r.campaign.status}`, ''];
  for (const f of rows) {
    out.push(`${f.status.padEnd(4)}  ${CHECKS[f.id] || f.id}: ${f.observed}`);
    if (f.status === FAIL || f.status === WARN) {
      if (f.why) out.push(`      why: ${f.why}`);
      if (f.fix) out.push(`      fix: ${f.fix}`);
    }
  }
  const v = verdict(r.findings);
  out.push('');
  out.push(v.safe ? 'SAFE TO ACTIVATE: every check passed.' : `DO NOT ACTIVATE: ${v.blocking.map((f) => CHECKS[f.id] || f.id).join('; ')}.`);
  if (!v.safe && r.dailySpend > 0 && /ACTIVE|ENABLED/.test(r.campaign.status)) {
    out.push(`It is live now, spending up to ${money(r.dailySpend, r.currency)}/day while it can't do its job.`);
  }
  return out.join('\n');
}
