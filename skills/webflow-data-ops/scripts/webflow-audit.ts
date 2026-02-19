import { readFile } from "node:fs/promises";
import {
  createDataOpsClientFromEnv,
  extractList,
  getString,
  type JsonObject,
} from "./webflow-client.ts";

type CliArgs = {
  command?: string;
  flags: Record<string, string | boolean>;
};

type AuditFinding = JsonObject;

type AuditResult = {
  site_id?: string;
  page_findings: AuditFinding[];
  component_findings: AuditFinding[];
  cms_findings: AuditFinding[];
  risk_summary: JsonObject;
};

type ChangeOperation = {
  kind: "update_page_metadata" | "update_component" | "upsert_cms_item";
  target: JsonObject;
  patch: JsonObject;
  reason: string;
};

const APPROVAL_PHRASE = "APPROVE_WEBFLOW_DRAFT_CHANGES";

function parseArgs(argv: string[]): CliArgs {
  const tokens = argv.slice(2);
  const command = tokens.shift();
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = tokens[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }

  return { command, flags };
}

function asString(flag: string | boolean | undefined): string | undefined {
  return typeof flag === "string" ? flag : undefined;
}

function scoreRisk(audit: AuditResult): JsonObject {
  const total =
    audit.page_findings.length + audit.component_findings.length + audit.cms_findings.length;
  const severity = total === 0 ? "low" : total < 15 ? "medium" : "high";
  return {
    severity,
    total_findings: total,
    publish_blocked: true,
    schema_changes_blocked: true,
  };
}

function normalizeTextLength(value: string | undefined): number {
  return value ? value.trim().length : 0;
}

function buildPageFindings(pages: JsonObject[]): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const page of pages) {
    const pageId = getString(page, ["id", "pageId"]);
    const slug = getString(page, ["slug", "path"]);
    const title = getString(page, ["title", "metaTitle", "name"]);
    const description = getString(page, ["metaDescription", "description"]);

    const issues: string[] = [];

    if (normalizeTextLength(title) < 25) {
      issues.push("title-too-short-or-missing");
    }
    if (normalizeTextLength(title) > 70) {
      issues.push("title-too-long");
    }
    if (normalizeTextLength(description) < 120) {
      issues.push("meta-description-too-short-or-missing");
    }
    if (normalizeTextLength(description) > 165) {
      issues.push("meta-description-too-long");
    }

    if (issues.length === 0) {
      continue;
    }

    const recommendedPatch: JsonObject = {};
    if (!title || title.length < 25) {
      recommendedPatch.title = `${title ?? "Page"} | Clear intent and outcome`;
    }
    if (!description || description.length < 120) {
      recommendedPatch.metaDescription =
        "Concise answer-first summary with explicit entities and user outcome. Keep factual and citation-ready.";
    }

    findings.push({
      page_id: pageId,
      slug,
      title,
      meta_description: description,
      issues,
      recommended_patch: recommendedPatch,
    });
  }

  return findings;
}

function buildComponentFindings(components: JsonObject[]): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const component of components) {
    const componentId = getString(component, ["id", "componentId"]);
    const name = getString(component, ["name", "displayName"]);

    // Component payloads vary by site. Surface review-needed findings for governance.
    findings.push({
      component_id: componentId,
      name,
      issues: ["manual-aeo-geo-review-recommended"],
      recommendation:
        "Ensure reusable component copy is answer-first, entity-explicit, and internally linkable.",
    });
  }

  return findings;
}

function buildCmsFindings(
  collections: JsonObject[],
  fieldsByCollection: Record<string, JsonObject[]>,
): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const collection of collections) {
    const collectionId = getString(collection, ["id", "collectionId"]);
    const name = getString(collection, ["name", "displayName"]);
    const fields = (collectionId && fieldsByCollection[collectionId]) || [];

    const fieldNames = fields
      .map((field) => getString(field, ["slug", "name"]))
      .filter((value): value is string => Boolean(value));

    const hasSeoDescription = fieldNames.some((field) =>
      field.toLowerCase().includes("description"),
    );
    const hasEntityField = fieldNames.some((field) =>
      ["entity", "topic", "intent", "answer"].some((needle) =>
        field.toLowerCase().includes(needle),
      ),
    );

    const issues: string[] = [];
    if (!hasSeoDescription) {
      issues.push("missing-explicit-description-field");
    }
    if (!hasEntityField) {
      issues.push("missing-explicit-entity-or-intent-field");
    }

    if (issues.length === 0) {
      continue;
    }

    findings.push({
      collection_id: collectionId,
      name,
      issues,
      recommendation:
        "Use existing content fields to keep answers factual, concise, and entity-explicit. Schema changes remain blocked in v1.",
    });
  }

  return findings;
}

async function runAudit(siteIdOverride?: string): Promise<AuditResult> {
  const { env, client } = createDataOpsClientFromEnv(process.env);
  const siteId = siteIdOverride ?? env.siteId;

  if (!client) {
    return {
      site_id: siteId,
      page_findings: [],
      component_findings: [],
      cms_findings: [],
      risk_summary: {
        mode: env.mode,
        status: "advisory-only",
        reason: env.reason,
        remediation: "Set WEBFLOW_SITE_API_TOKEN and WEBFLOW_SITE_ID for data operations.",
      },
    };
  }

  if (!siteId) {
    const sites = await client.listSites();
    return {
      site_id: undefined,
      page_findings: [],
      component_findings: [],
      cms_findings: [],
      risk_summary: {
        mode: "site-token",
        status: "target-site-required",
        reason: "WEBFLOW_SITE_ID was not set.",
        available_sites: extractList(sites).map((site) => ({
          id: getString(site, ["id", "siteId"]),
          name: getString(site, ["displayName", "name"]),
          short_name: getString(site, ["shortName", "slug"]),
        })),
      },
    };
  }

  const [pagesRaw, componentsRaw, collectionsRaw] = await Promise.all([
    client.listPages(siteId),
    client.listComponents(siteId),
    client.listCollections(siteId),
  ]);

  const pages = extractList(pagesRaw);
  const components = extractList(componentsRaw);
  const collections = extractList(collectionsRaw);

  const fieldsByCollection: Record<string, JsonObject[]> = {};
  await Promise.all(
    collections.map(async (collection) => {
      const collectionId = getString(collection, ["id", "collectionId"]);
      if (!collectionId) {
        return;
      }
      try {
        const fields = await client.listCollectionFields(collectionId);
        fieldsByCollection[collectionId] = extractList(fields);
      } catch {
        fieldsByCollection[collectionId] = [];
      }
    }),
  );

  const audit: AuditResult = {
    site_id: siteId,
    page_findings: buildPageFindings(pages),
    component_findings: buildComponentFindings(components),
    cms_findings: buildCmsFindings(collections, fieldsByCollection),
    risk_summary: {},
  };

  audit.risk_summary = scoreRisk(audit);
  return audit;
}

function buildPlan(audit: AuditResult): JsonObject {
  const operations: ChangeOperation[] = [];

  for (const finding of audit.page_findings) {
    const pageId = finding.page_id;
    const patch = finding.recommended_patch;

    if (!pageId || !patch || typeof patch !== "object" || Object.keys(patch).length === 0) {
      continue;
    }

    operations.push({
      kind: "update_page_metadata",
      target: {
        site_id: audit.site_id,
        page_id: pageId,
      },
      patch: patch as JsonObject,
      reason: "SEO/AEO metadata quality improvement",
    });
  }

  return {
    site_id: audit.site_id,
    generated_at: new Date().toISOString(),
    mode: "draft",
    approval_phrase: APPROVAL_PHRASE,
    operations,
    blocked_by_default: [
      "collection-schema-mutations",
      "destructive-deletes",
      "publish-or-live-endpoints",
    ],
    source_summary: {
      page_findings: audit.page_findings.length,
      component_findings: audit.component_findings.length,
      cms_findings: audit.cms_findings.length,
    },
  };
}

async function main() {
  const { command, flags } = parseArgs(process.argv);

  if (!command || (command !== "audit_webflow_site" && command !== "plan_webflow_changes")) {
    console.error(
      "Usage: bun webflow-audit.ts <audit_webflow_site|plan_webflow_changes> [--site-id <id>] [--audit-file <path>]",
    );
    process.exit(1);
  }

  const siteId = asString(flags["site-id"]);

  if (command === "audit_webflow_site") {
    const audit = await runAudit(siteId);
    console.log(JSON.stringify(audit, null, 2));
    return;
  }

  const auditFile = asString(flags["audit-file"]);
  let audit: AuditResult;

  if (auditFile) {
    const raw = await readFile(auditFile, "utf-8");
    audit = JSON.parse(raw) as AuditResult;
  } else {
    audit = await runAudit(siteId);
  }

  const plan = buildPlan(audit);
  console.log(JSON.stringify(plan, null, 2));
}

await main();
