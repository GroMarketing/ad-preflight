import { FAIL, PASS, SKIP, WARN, finding } from './report.mjs';

/**
 * Fetch each destination URL. A 200 is the minimum; what the page lets a
 * visitor do is still a human's call, so the report names the final URL.
 */
export async function checkLanding(urls, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const unique = [...new Set(urls.filter(Boolean))];
  if (!unique.length) return finding('landing', SKIP, 'no click-out URLs (lead form or no destination)');
  const results = [];
  for (const url of unique) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetchImpl(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ad-preflight)' } });
      clearTimeout(t);
      results.push({ url, status: res.status, final: res.url || url });
    } catch (e) {
      results.push({ url, status: 'error', error: e.name === 'AbortError' ? 'timed out' : e.message });
    }
  }
  const bad = results.filter((r) => r.status === 'error' || r.status >= 400);
  const desc = results.map((r) => `${r.url} -> ${r.status}${r.final && r.final !== r.url ? ` (${r.final})` : ''}${r.error ? ` ${r.error}` : ''}`).join('; ');
  if (bad.length) return finding('landing', FAIL, desc, { why: 'Paid clicks land on an error page.', fix: 'Fix the page or the URL before spending.' });
  const redirected = results.filter((r) => r.final && new URL(r.final).hostname !== new URL(r.url).hostname);
  if (redirected.length) return finding('landing', WARN, desc, { why: 'The ad URL redirects to a different domain.', fix: 'Point the ad at the final URL so tracking and policy review see the real page.' });
  return finding('landing', PASS, desc);
}
