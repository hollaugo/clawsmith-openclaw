---
name: webflow-data-ops
description: Deterministic Webflow data operations for site/pages/components/CMS with approval-gated writes and SEO/AEO/GEO-safe guardrails.
homepage: https://developers.webflow.com
metadata:
  {
    "openclaw":
      {
        "emoji": "🧩",
        "requires": { "bins": ["bun"], "env": ["WEBFLOW_SITE_API_TOKEN", "WEBFLOW_SITE_ID"] },
        "primaryEnv": "WEBFLOW_SITE_API_TOKEN",
      },
  }
---

# Webflow Data Ops

Use this skill for deterministic data operations against Webflow site endpoints.

## Scope

- Reads: sites, pages, components, collections, fields, and items.
- Writes (approval-gated):
  - page metadata updates
  - component updates
  - CMS item create/update

Blocked by policy:

- schema mutations (collection/field changes)
- destructive deletes
- publish/live operations

## Token routing policy

- Primary: `WEBFLOW_SITE_API_TOKEN`
- Optional only: `WEBFLOW_WORKSPACE_API_TOKEN` (not used for data writes here)
- If site token is missing: return read-only advisory output

Never print tokens in output.

## Deterministic command surface

All commands are explicit and machine-readable.

### `audit_webflow_site`

```bash
bun {baseDir}/scripts/webflow-audit.ts audit_webflow_site --site-id "$WEBFLOW_SITE_ID"
```

Output JSON contract:

- `site_id`
- `page_findings[]`
- `component_findings[]`
- `cms_findings[]`
- `risk_summary`

### `plan_webflow_changes`

```bash
bun {baseDir}/scripts/webflow-audit.ts plan_webflow_changes --site-id "$WEBFLOW_SITE_ID"
```

Or from an existing audit file:

```bash
bun {baseDir}/scripts/webflow-audit.ts plan_webflow_changes --audit-file /tmp/webflow-audit.json
```

### `apply_webflow_changes`

```bash
bun {baseDir}/scripts/webflow-apply.ts apply_webflow_changes \
  --plan-file /tmp/webflow-plan.json \
  --approval "APPROVE_WEBFLOW_DRAFT_CHANGES" \
  --write
```

Output JSON contract:

- `attempted_ops[]`
- `successful_ops[]`
- `blocked_ops[]`
- `verification_results[]`
- `next_actions[]`

## Safety workflow

1. Discovery + audit first.
2. Generate plan with explicit operations.
3. Require explicit approval phrase.
4. Apply only allowlisted writes.
5. Verify by re-reading changed records.
6. Return structured report.

## SEO/AEO/GEO implementation rules

- SEO: concise intent-first titles, clear meta descriptions, metadata consistency.
- AEO: answer-first copy, explicit entities, concise retrieval-friendly structures.
- GEO (Generative Engine Optimization): factual and attribution-ready phrasing, strong headings/chunking, explicit internal-link context.

## Required runtime env

- `WEBFLOW_SITE_API_TOKEN` (required)
- `WEBFLOW_SITE_ID` (required default target)
- `WEBFLOW_WORKSPACE_API_TOKEN` (optional, reserved)
