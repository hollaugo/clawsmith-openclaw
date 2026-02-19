import { readFile } from "node:fs/promises";
import { createDataOpsClientFromEnv, type JsonObject, getString } from "./webflow-client.ts";

type CliArgs = {
  command?: string;
  flags: Record<string, string | boolean>;
};

type ChangeOperation = {
  kind: string;
  target: JsonObject;
  patch: JsonObject;
  reason?: string;
};

type ApplyResult = {
  attempted_ops: JsonObject[];
  successful_ops: JsonObject[];
  blocked_ops: JsonObject[];
  verification_results: JsonObject[];
  next_actions: string[];
};

const DEFAULT_APPROVAL_PHRASE = "APPROVE_WEBFLOW_DRAFT_CHANGES";
const ALLOWED_WRITE_KINDS = new Set([
  "update_page_metadata",
  "update_component",
  "upsert_cms_item",
]);
const HARD_BLOCKED_KINDS = new Set([
  "delete_collection",
  "delete_item",
  "delete_page",
  "publish_site",
  "publish_collection",
  "update_collection_schema",
  "update_field_schema",
]);

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

function isTrue(flag: string | boolean | undefined): boolean {
  return flag === true || flag === "true";
}

async function readPlan(
  planFile: string,
): Promise<{ site_id?: string; operations: ChangeOperation[] }> {
  const raw = await readFile(planFile, "utf-8");
  const parsed = JSON.parse(raw) as JsonObject;
  const operationsRaw = parsed.operations;
  const operations = Array.isArray(operationsRaw)
    ? operationsRaw.filter(
        (item): item is ChangeOperation => Boolean(item) && typeof item === "object",
      )
    : [];
  const siteId = typeof parsed.site_id === "string" ? parsed.site_id : undefined;
  return { site_id: siteId, operations };
}

function block(result: ApplyResult, operation: ChangeOperation, reason: string) {
  result.blocked_ops.push({
    kind: operation.kind,
    target: operation.target,
    reason,
  });
}

async function verify(
  kind: string,
  target: JsonObject,
  patch: JsonObject,
  reader: () => Promise<JsonObject>,
): Promise<JsonObject> {
  const current = await reader();
  const checks = Object.entries(patch).map(([key, expected]) => ({
    field: key,
    expected,
    actual: current[key],
    ok: JSON.stringify(current[key]) === JSON.stringify(expected),
  }));

  return {
    kind,
    target,
    ok: checks.every((entry) => entry.ok),
    checks,
  };
}

async function main() {
  const { command, flags } = parseArgs(process.argv);
  if (command !== "apply_webflow_changes") {
    console.error(
      "Usage: bun webflow-apply.ts apply_webflow_changes --plan-file <path> --approval <phrase> [--write]",
    );
    process.exit(1);
  }

  const planFile = asString(flags["plan-file"]);
  if (!planFile) {
    throw new Error("--plan-file is required");
  }

  const approval = asString(flags.approval);
  const requiredApproval = asString(flags["approval-phrase"]) ?? DEFAULT_APPROVAL_PHRASE;
  const writeEnabled = isTrue(flags.write);

  const { site_id: plannedSiteId, operations } = await readPlan(planFile);

  const result: ApplyResult = {
    attempted_ops: [],
    successful_ops: [],
    blocked_ops: [],
    verification_results: [],
    next_actions: [],
  };

  const runtime = createDataOpsClientFromEnv(process.env);
  const siteId = asString(flags["site-id"]) ?? plannedSiteId ?? runtime.env.siteId;

  if (!runtime.client) {
    for (const operation of operations) {
      block(result, operation, runtime.env.reason ?? "WEBFLOW_SITE_API_TOKEN missing");
    }
    result.next_actions.push("Set WEBFLOW_SITE_API_TOKEN and retry in site-token mode.");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!siteId) {
    for (const operation of operations) {
      block(result, operation, "target-site-required");
    }
    result.next_actions.push("Set WEBFLOW_SITE_ID or provide --site-id.");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (approval !== requiredApproval) {
    for (const operation of operations) {
      block(result, operation, `approval phrase mismatch; expected ${requiredApproval}`);
    }
    result.next_actions.push(`Re-run with --approval ${requiredApproval}.`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!writeEnabled) {
    for (const operation of operations) {
      block(result, operation, "write-flag-required");
    }
    result.next_actions.push("Re-run with --write after reviewing blocked operations.");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  for (const operation of operations) {
    result.attempted_ops.push({
      kind: operation.kind,
      target: operation.target,
      reason: operation.reason,
    });

    if (HARD_BLOCKED_KINDS.has(operation.kind)) {
      block(result, operation, "operation blocked by policy");
      continue;
    }

    if (!ALLOWED_WRITE_KINDS.has(operation.kind)) {
      block(result, operation, "operation kind is not allowlisted");
      continue;
    }

    try {
      if (operation.kind === "update_page_metadata") {
        const pageId = getString(operation.target, ["page_id", "id"]);
        if (!pageId) {
          block(result, operation, "missing page_id");
          continue;
        }

        await runtime.client.updatePage(siteId, pageId, operation.patch);
        const verification = await verify(
          operation.kind,
          operation.target,
          operation.patch,
          async () => await runtime.client!.getPage(siteId, pageId),
        );

        result.successful_ops.push({ kind: operation.kind, target: operation.target });
        result.verification_results.push(verification);
        continue;
      }

      if (operation.kind === "update_component") {
        const componentId = getString(operation.target, ["component_id", "id"]);
        if (!componentId) {
          block(result, operation, "missing component_id");
          continue;
        }

        await runtime.client.updateComponent(siteId, componentId, operation.patch);
        const verification = await verify(
          operation.kind,
          operation.target,
          operation.patch,
          async () => await runtime.client!.getComponent(siteId, componentId),
        );

        result.successful_ops.push({ kind: operation.kind, target: operation.target });
        result.verification_results.push(verification);
        continue;
      }

      if (operation.kind === "upsert_cms_item") {
        const collectionId = getString(operation.target, ["collection_id"]);
        const itemId = getString(operation.target, ["item_id", "id"]);

        if (!collectionId) {
          block(result, operation, "missing collection_id");
          continue;
        }

        if (itemId) {
          await runtime.client.updateCollectionItem(collectionId, itemId, operation.patch);
          const verification = await verify(
            operation.kind,
            operation.target,
            operation.patch,
            async () => await runtime.client!.getCollectionItem(collectionId, itemId),
          );
          result.successful_ops.push({ kind: operation.kind, target: operation.target });
          result.verification_results.push(verification);
        } else {
          const created = await runtime.client.createCollectionItem(collectionId, operation.patch);
          result.successful_ops.push({ kind: operation.kind, target: operation.target, created });
          result.verification_results.push({
            kind: operation.kind,
            target: operation.target,
            ok: true,
            checks: [{ field: "create", expected: "created", actual: "created", ok: true }],
          });
        }
      }
    } catch (error) {
      block(result, operation, error instanceof Error ? error.message : "unknown write error");
    }
  }

  if (result.blocked_ops.length > 0) {
    result.next_actions.push(
      "Review blocked_ops and adjust the plan for allowlisted operations only.",
    );
  }
  if (result.successful_ops.length > 0) {
    result.next_actions.push("Run a follow-up audit to confirm SEO/AEO/GEO improvements.");
  }

  console.log(JSON.stringify(result, null, 2));
}

await main();
