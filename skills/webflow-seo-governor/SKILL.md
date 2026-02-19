---
name: webflow-seo-governor
description: Governance and planning policy for Webflow SEO/AEO/GEO workflows. Enforces draft-first approvals and blocks destructive operations.
homepage: https://docs.openclaw.ai/tools/skills
metadata: { "openclaw": { "emoji": "🧭" } }
---

# Webflow SEO Governor

Use this skill to decide **what** to change and **when** to permit writes.

This skill does not directly mutate Webflow. It governs execution by routing write actions through `webflow-data-ops`.

## OpenClaw config wiring

Set these entries in `~/.openclaw/openclaw.json`:

```json5
{
  skills: {
    entries: {
      "webflow-data-ops": {
        enabled: true,
        apiKey: "<WEBFLOW_SITE_API_TOKEN>",
        env: {
          WEBFLOW_SITE_ID: "<YOUR_SITE_ID>",
        },
      },
      "webflow-seo-governor": {
        enabled: true,
      },
    },
  },
}
```

## Policy defaults

- Token policy:
  - Use `WEBFLOW_SITE_API_TOKEN` for data operations.
  - Treat `WEBFLOW_WORKSPACE_API_TOKEN` as reserved and non-primary for v1 data writes.
- Safety mode:
  - Draft-first with explicit approval phrase.
- Blocked-by-default operations:
  - schema changes
  - destructive deletes
  - publish/live operations

## Mandatory workflow

1. Run audit (`audit_webflow_site`) and collect findings.
2. Build plan (`plan_webflow_changes`) with explicit per-object patches.
3. Request approval phrase: `APPROVE_WEBFLOW_DRAFT_CHANGES`.
4. Only then run `apply_webflow_changes --write`.
5. Summarize applied and blocked operations with verification results.

## Decision rubric

Prioritize changes by this order:

1. Missing/weak page metadata impacting discoverability.
2. AEO/GEO clarity gaps in key landing pages.
3. CMS content consistency for reusable entities/topics.
4. Component-level clarity improvements.

## Refusal rules

Refuse execution and produce remediation steps when:

- `WEBFLOW_SITE_API_TOKEN` is missing
- target site is unresolved
- approval phrase is absent or mismatched
- operation requests schema, destructive, or publish action

## Output requirements

Every governed run must produce:

- rationale for selected operations
- explicit blocked operations and reasons
- rollback-friendly notes (what changed, where, and why)
