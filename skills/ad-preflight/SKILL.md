---
name: ad-preflight
description: Verify against the live Meta, LinkedIn or Google Ads API that a paid campaign can actually serve and convert (valid bid, click destination or real lead form, approval, geo, spend bound, working landing page), and reconcile real spend against what the records claim. Use BEFORE activating any campaign, AFTER any edit to a live one, whenever a campaign spends without producing its outcome, and before quoting any spend or CAC figure.
---

# ad-preflight

A broken ad looks identical to a working one in every dashboard summary: status
ACTIVE, creative APPROVED, impressions rising. Only specific fields, read from
the platform API, show the difference. This skill reads them.

**Read-only, always.** Never activate, pause, un-pause or edit a campaign as part
of this skill. Report; a human decides.

## Preflight one campaign

Use the MCP tools if the `ad-preflight` server is connected, otherwise the CLI:

```bash
npx ad-preflight meta <campaign_id> --region "Ohio"
npx ad-preflight linkedin <campaign_id> --account <ad_account_id> --country "United States"
npx ad-preflight google <customer_id> <campaign_id> --country US
```

Always pass `--region` or `--country` when you know where the campaign should
run. Without it, geo is listed but not verified. City names collide across
states, so a label in a spec proves nothing; the resolved region does.

What each check means when it fails:

| Check | What breaks in practice |
|---|---|
| Schedule | End date passed: activating does nothing. |
| Bid | No target and no manual bid (LinkedIn `NONE` + `$0`; Meta cost cap with no amount; Google manual CPC at `$0`) loses every auction while showing ACTIVE. |
| Destination | Video/image ads with no landing page still serve and log "clicks" (profile, expand, play) but landing-page clicks stay 0 forever. A placeholder or inactive lead form means no form. |
| Live | Rejected, or approved but not serving: read the hold reasons. |
| Geo | It will serve wherever the key resolved, not where the spec says. |
| Spend | A daily budget is not a cap. With no end date, total budget or account cap, exposure is open-ended. |
| Landing | Paid clicks land on an error. A 200 is the minimum: also ask whether the page lets the visitor do what the ad promised. |

Lead with the finding that costs money. End with the verdict line exactly as the
tool prints it (SAFE TO ACTIVATE / DO NOT ACTIVATE). If a live campaign fails,
say what it spends per day while unable to do its job.

## Reconcile spend

```bash
npx ad-preflight spend --meta act_<id> --linkedin <id> --google <customer_id> --days 30 --ledger ledger.json
```

The ledger is what your records claim: `[{ "platform", "campaign" (id or name), "spend"?, "status"? }]`.
Build it from the notes, docs or spreadsheet that the spend figure came from.
**"We paused it" is a claim, not a fact**, and so is any figure in a document.

Report, in this order:
1. How many campaigns can spend right now, and the total spent in the window.
2. Per platform: campaign, status, spend, outcome, cost per outcome.
3. **Discrepancies**: what the record claims, what the platform says, the gap.
   If none, say so explicitly; that is a real result.
4. **Drift**: live campaigns missing from the ledger, paused campaigns still
   SERVING (one switch from spending), Meta accounts with no spend cap, and
   spend with zero clicks and zero leads (usually a structural break, not the copy;
   preflight it).

Also check what can change campaign state without a human (schedulers, cron
jobs, automation rules). A paused campaign with a live scheduler pointed at it
is not paused.
