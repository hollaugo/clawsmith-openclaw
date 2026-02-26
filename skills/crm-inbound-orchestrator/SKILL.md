---
name: crm-inbound-orchestrator
description: Hourly CRM inbound orchestrator for three inboxes using Notion-synced SOP, strict business-lead filtering, Supabase persistence, and actionable-only Slack reporting.
homepage: https://docs.openclaw.ai/automation/cron-jobs
metadata:
  {
    "openclaw":
      {
        "emoji": "📥",
        "requires":
          {
            "bins": ["tsx", "gog"],
            "env":
              [
                "NOTION_API_KEY",
                "CRM_SOP_PAGE_ID",
                "CRM_MONITORED_EMAILS",
                "CRM_POLL_QUERY",
                "CRM_POLL_OVERLAP_MINUTES",
                "SUPABASE_URL",
                "SUPABASE_SECRET_KEY",
              ],
          },
      },
  }
---

# CRM Inbound Orchestrator

Use this skill for hourly polling CRM workflows across:

- `pat.ugosuji@gmail.com`
- `info@promptcircle.com`
- `ugo@promptcircle.com`

The source-of-truth SOP is synced from Notion page `CRM_SOP_PAGE_ID` every run.

## Runtime Env Contract

Required:

- `NOTION_API_KEY`
- `CRM_SOP_PAGE_ID` (default: `31288fb313488013924ade7bf704ab6f`)
- `CRM_MONITORED_EMAILS` (comma-separated)
- `CRM_POLL_QUERY` (default: `in:inbox -in:spam -in:trash`)
- `CRM_POLL_OVERLAP_MINUTES` (default: `120`)
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`

Optional:

- `CRM_POLL_MAX_RESULTS` (default: `200`)
- `CRM_SOP_CACHE_FILE` (default: `/tmp/crm-inbound-sop-cache.json`)
- `CRM_POLL_STATE_TABLE` (default: `crm_poll_state`)
- `CRM_CONTACTS_TABLE` (default: `crm_contacts`)
- `CRM_ACTIVITIES_TABLE` (default: `crm_activities`)
- `CRM_DRAFTS_TABLE` (default: `crm_drafts`)
- `CRM_ACCOUNTING_TABLE` (default: `accounting_entries`)
- `CRM_JOB_RUNS_TABLE` (default: `crm_job_runs`)
- `GOG_ACCOUNT` (fallback sender account for approvals)
- `CRM_OUTSTANDING_LOOKBACK_DAYS` (default: `7`)
- `CRM_OUTSTANDING_STALE_HOURS` (default: `24`)

## Deterministic Command Surface

### 1) Fetch Notion SOP

```bash
tsx {baseDir}/scripts/fetch-sop.ts fetch_sop
```

Optional flags:

- `--page-id <id>`
- `--cache-file <path>`
- `--output <path>`

### 2) Poll Inboxes Hourly

```bash
tsx {baseDir}/scripts/poll-inboxes.ts poll_inboxes
```

Optional flags:

- `--accounts <csv>`
- `--query <gmail-query>`
- `--overlap-minutes <n>`
- `--output <path>`

### 3) Classify + Route + Persist

```bash
tsx {baseDir}/scripts/process-inbound.ts process_inbound \
  --poll-file /tmp/crm-poll.json
```

Optional flags:

- `--sop-file <path>`
- `--output <path>`

### 4) Approval Actions

```bash
tsx {baseDir}/scripts/approval-action.ts approval_action \
  --action approve \
  --draft-id <draft_id> \
  --approved-by "U052337J8QH"
```

Also supported:

- `--action revise --notes "<feedback>"`
- `--action reject --reason "<reason>"`

### 5) Morning Outstanding Check (Actionable-Only Report)

```bash
tsx {baseDir}/scripts/check-outstanding.ts check_outstanding
```

Optional flags:

- `--lookback-days <n>` (default: `7`)
- `--stale-hours <n>` (default: `24`)
- `--output <path>`

## Slack Text Approval Contract

Expose these through `/skill`:

- `/skill crm-inbound-orchestrator approve <draft_id>`
- `/skill crm-inbound-orchestrator revise <draft_id> <notes>`
- `/skill crm-inbound-orchestrator reject <draft_id> <reason>`

## Workflow Rules

1. Poll hourly from all configured inboxes.
2. Deduplicate by `account_email:message_id`.
3. Classify cheaply into `receipt|sales|support|ignore`.
4. Sales path:
   - upsert contact
   - log activity
   - apply SOP context
   - create draft only for human, direct business inquiries (consulting/sponsorship/partnership intent)
5. Accounting path:
   - parse vendor/date/amount/currency
   - upsert accounting entry
6. No side effects until explicit approval action.
7. Slack reporting is actionable-only:
   - no hourly heartbeat/status spam
   - post only draft approvals and outstanding follow-up reports

## Data Contract

Tables:

- `crm_contacts`
- `crm_activities`
- `crm_drafts`
- `accounting_entries`
- `crm_job_runs`
- `crm_poll_state`

Reference DDL:

```bash
cat {baseDir}/references/supabase-schema.sql
```

## Hourly Cron Setup (No Hourly Announce Spam)

```bash
openclaw cron add \
  --name "CRM hourly polling" \
  --cron "0 * * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Run crm-inbound-orchestrator hourly polling cycle. Use skill crm-inbound-orchestrator. Run fetch_sop, poll_inboxes, process_inbound. Only report actionable items."
```

## Morning 9:20 Outstanding Sweep

```bash
openclaw cron add \
  --name "CRM morning outstanding check" \
  --cron "20 9 * * *" \
  --tz "America/Toronto" \
  --session isolated \
  --message "Run crm-inbound-orchestrator outstanding review. Use skill crm-inbound-orchestrator. Run check_outstanding for last 7 days and only post if stale drafts or unanswered sales leads exist."
```

## Safety

- Do not log secrets or tokens.
- If Notion fetch fails, use cached SOP and report `degraded`.
- If one inbox fails, continue others and report partial failure.
- Keep outbound email behind explicit approval action.
