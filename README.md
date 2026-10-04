# ad-preflight

**Can this campaign actually serve, and if it serves, can it convert?**

`ad-preflight` reads a Meta, LinkedIn or Google Ads campaign from the platform's
API and checks the fields that decide that. It also reconciles real spend
across all three against what your records say. It's a CLI, a library and an
MCP server, and it is **read-only**: it never activates, pauses or edits
anything.

```
$ node examples/offline-demo.mjs        # a real preflight against a fake, broken campaign

LinkedIn campaign 123456789  "Q3 webinar - video"
status: ACTIVE

FAIL  Can win an auction: CPV / NONE / unitCost 0
      why: No optimization target and no manual bid is no bid at all. It shows ACTIVE and APPROVED and serves nothing.
      fix: Set an auto-bid target for the objective (e.g. MAX_LEAD, MAX_VIDEO_VIEW) or a manual unitCost above 0.
FAIL  Has somewhere to send people: webinar_15s: media post with no contentLandingPage and no contentCallToActionLabel
      why: Video and image posts without a landing page still serve and log clicks (profile, expand, play), but landing-page clicks stay at 0 forever. A placeholder form URN means no lead form.
      fix: Set contentLandingPage and contentCallToActionLabel on the post, or a real urn:li:adForm destination for lead gen.
PASS  Schedule lets it serve: ACTIVE, ends 2026-11-30
PASS  Creative is approved and serving: webinar_15s: ACTIVE serving
PASS  Geo resolves to the intended place: Columbus, Ohio, United States
PASS  Spend is bounded: total budget $1500.00, $50.00/day
SKIP  Landing page works: no click-out URLs (lead form or no destination)

DO NOT ACTIVATE: Can win an auction; Has somewhere to send people.
It is live now, spending up to $50.00/day while it can't do its job.
```

Try it with no credentials: `node examples/offline-demo.mjs` runs the real checks against
mocked API responses for a campaign with two classic faults.

## Why

A broken ad looks exactly like a working one in every dashboard summary: status
ACTIVE, creative APPROVED, impressions rising. The difference is usually in one
field that nobody checks. Each check here exists because that field was wrong on a
real account:

- **No bid.** A LinkedIn campaign with `optimizationTargetType: NONE` and a $0
  unit cost sat ACTIVE and APPROVED for three days and served one impression.
  The same config shipped again on the next campaign, because the "fix" was
  patched onto live campaigns and never reached the tool that created them.
- **No destination.** Every video ad an uploader built went out with no
  landing page. The ads served and logged clicks (profile views, video
  expands), so nothing looked wrong. About $2,000 bought around a dozen landing-page clicks
  and no leads, and for two months the copy got the blame.
- **Wrong place.** City targeting keys collide across states. A spec that says
  "Springfield" proves nothing about which Springfield the platform resolved.
- **Wrong numbers.** The record said a pilot was "paused, about $300 spent". The
  API said about $2,000. The gap stood for five weeks, and every decision made in that
  time used the wrong figure.

## Install

```bash
npm install -g ad-preflight      # or use npx
```

Credentials come **only from environment variables**. Nothing is written to
disk, and tokens travel in request headers, never URLs, so they stay out of
platform error messages and logs. Errors are scrubbed of credential values
before printing. Read-only scopes are enough. See [`.env.example`](.env.example).

| Platform | Variables | Scope |
|---|---|---|
| Meta | `META_ACCESS_TOKEN` | `ads_read` |
| LinkedIn | `LINKEDIN_ACCESS_TOKEN`, optional `LINKEDIN_AD_ACCOUNT_ID` | `r_ads`, `r_ads_reporting` |
| Google Ads | `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | `adwords` |

API versions default to Meta `v24.0`, LinkedIn `202509` and Google Ads `v25`.
Override them with `META_API_VERSION`, `LINKEDIN_API_VERSION` or
`GOOGLE_ADS_API_VERSION`.

## Preflight a campaign

```bash
ad-preflight meta <campaign_id> --region "Ohio"
ad-preflight linkedin <campaign_id> --account <ad_account_id> --country "United States"
ad-preflight google <customer_id> <campaign_id> --country US
```

Exit code `0` = SAFE TO ACTIVATE, `1` = DO NOT ACTIVATE, `2` = error. Add
`--json` for machine output.

| Check | Meta | LinkedIn | Google Ads |
|---|---|---|---|
| **Schedule** lets it serve | `stop_time` | status, `runSchedule.end` | serving status, end date |
| **Bid** can win an auction | cost/bid cap needs `bid_amount` | auto-bid target, or `unitCost > 0` | manual bids > 0, tCPA/tROAS targets set |
| **Destination** exists | link, CTA link, or an **active** lead form | `contentLandingPage` + CTA on media posts, article source, real `urn:li:adForm` | final URLs |
| **Live** | `effective_status`, review feedback | `intendedStatus`, review, `isServing` + hold reasons | approval and review status |
| **Geo** resolves where you meant | every city/region/zip's resolved region | every location URN resolved to its name | geo target canonical names |
| **Spend** is bounded | lifetime budget, end date, account `spend_cap` | `totalBudget` or end date | total budget or end date |
| **Landing** page works | fetched, status + redirects | fetched | fetched |

Pass `--region` or `--country` whenever you know where the campaign should run.
Without it, geo is listed for you to read but not verified.

## Reconcile spend

```bash
ad-preflight spend --meta act_123 --linkedin 500000000 --google 123-456-7890 --days 30
ad-preflight spend --meta act_123 --ledger ledger.json          # exit 1 on any discrepancy
```

It pulls real spend per campaign from each platform's reporting endpoint, then
reports:

- **What can spend right now**, as a headline number. On Google Ads, a paused
  campaign whose serving status is still `SERVING` is listed as **armed**: one
  switch from spending. A past end date (serving status `ENDED`) is the real
  brake.
- **Discrepancies** against your ledger: spend gaps over 2% (or $1), and
  campaigns your records call paused that can spend.
- **Drift**: live campaigns missing from the ledger, Meta accounts with no
  spend cap, and campaigns that spent money for zero clicks and zero leads
  (usually a structural break, so preflight them).

The ledger is what your records claim. See [`examples/ledger.example.json`](examples/ledger.example.json):

```json
[{ "platform": "LinkedIn", "campaign": "123456789", "spend": 300, "status": "paused" }]
```

## MCP server

```bash
claude mcp add ad-preflight -- npx -y ad-preflight mcp     # Claude Code
```

For Cursor, Claude Desktop and others:

```json
{ "mcpServers": { "ad-preflight": { "command": "npx", "args": ["-y", "ad-preflight", "mcp"] } } }
```

Tools: `preflight_meta_campaign`, `preflight_linkedin_campaign`,
`preflight_google_ads_campaign`, `reconcile_ad_spend`. All four are annotated
read-only.

## Claude Code plugin

```
/plugin marketplace add GroMarketing/ad-preflight
/plugin install ad-preflight@ad-preflight
```

It installs the MCP server and a skill that runs a preflight before any
activation and reconciles spend before any CAC figure is quoted. Results are
reported the same way every time: failures first, observed values instead of
"looks fine", and an explicit verdict.

## Library

```js
import { preflightMeta, reconcile, formatReport } from 'ad-preflight';

const report = await preflightMeta('120000000000000000', { region: 'Ohio' });
console.log(formatReport(report));
```

## What it doesn't do

- **It doesn't judge creative, copy or targeting strategy.** It answers whether
  the campaign is structurally able to serve and convert.
- **It doesn't verify conversion tracking end to end.** Whether your pixel or
  CAPI event fires on the landing page needs a browser test.
- **It never writes.** Fixes are printed as instructions; making them stays
  your call.

## License

MIT
