import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { FAIL, PASS, SKIP, WARN, finding } from './report.mjs';

/** Loopback, private, link-local (incl. cloud metadata), CGNAT, unspecified and ULA ranges. */
function isInternal(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isInternal(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/**
 * Landing URLs come from ad creatives, which anyone with edit access to the account can set.
 * Only public http(s) addresses are fetched, every redirect hop is re-checked, and the body
 * is never read: the result is the status code and the final URL.
 */
async function safeUrl(raw, resolve) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol} URLs are not checked`;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await resolve(host).catch(() => [])).map((a) => a.address);
  if (!addrs.length) return `${host} does not resolve`;
  if (addrs.some(isInternal)) return `${host} points at an internal address; not fetched`;
  return null;
}

const defaultResolve = (host) => lookup(host, { all: true, verbatim: true });

export async function checkLanding(urls, { fetchImpl = globalThis.fetch, timeoutMs = 15000, resolve = defaultResolve } = {}) {
  const unique = [...new Set(urls.filter(Boolean))];
  if (!unique.length) return finding('landing', SKIP, 'no click-out URLs (lead form or no destination)');
  const results = [];
  for (const url of unique) {
    let current = url;
    let status;
    let error;
    try {
      for (let hop = 0; hop < 6; hop++) {
        const blocked = await safeUrl(current, resolve);
        if (blocked) { error = blocked; break; }
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetchImpl(current, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ad-preflight)' } });
        clearTimeout(t);
        res.body?.cancel?.().catch(() => {});
        status = res.status;
        const loc = res.headers?.get?.('location');
        if (status >= 300 && status < 400 && loc) { current = new URL(loc, current).toString(); continue; }
        break;
      }
      if (!error && status >= 300 && status < 400) error = 'too many redirects';
    } catch (e) {
      error = e.name === 'AbortError' ? 'timed out' : e.message;
    }
    results.push({ url, status: error ? 'error' : status, final: current, error });
  }
  const bad = results.filter((r) => r.status === 'error' || r.status >= 400);
  const desc = results.map((r) => `${r.url} -> ${r.status}${r.final && r.final !== r.url ? ` (${r.final})` : ''}${r.error ? ` ${r.error}` : ''}`).join('; ');
  if (bad.length) return finding('landing', FAIL, desc, { why: 'Paid clicks land on an error page, or the URL could not be checked safely.', fix: 'Fix the page or the URL before spending.' });
  const redirected = results.filter((r) => r.final && new URL(r.final).hostname !== new URL(r.url).hostname);
  if (redirected.length) return finding('landing', WARN, desc, { why: 'The ad URL redirects to a different domain.', fix: 'Point the ad at the final URL so tracking and policy review see the real page.' });
  return finding('landing', PASS, desc);
}

export const _internal = { isInternal, safeUrl };
