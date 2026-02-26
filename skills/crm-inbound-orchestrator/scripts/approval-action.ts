import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

type CliArgs = {
  command?: string;
  flags: Record<string, string | boolean>;
};

type ApprovalAction = "approve" | "revise" | "reject";

type DraftRecord = {
  id: string;
  activity_id?: string;
  account_email?: string;
  to_email?: string;
  subject?: string;
  body?: string;
  status?: string;
  reply_to_message_id?: string;
};

type ActionResult = {
  command: "approval_action";
  action: ApprovalAction;
  draft_id: string;
  ok: boolean;
  message: string;
  email_sent?: boolean;
  updated_status?: string;
};

const execFileAsync = promisify(execFile);

const DEFAULT_DRAFTS_TABLE = "crm_drafts";
const DEFAULT_ACTIVITIES_TABLE = "crm_activities";

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

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseAction(value: string | undefined): ApprovalAction | undefined {
  const normalized = clean(value)?.toLowerCase();
  if (normalized === "approve" || normalized === "revise" || normalized === "reject") {
    return normalized;
  }
  return undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

async function supabaseRequest<T>(options: {
  supabaseUrl: string;
  serviceKey: string;
  method: "GET" | "PATCH";
  table: string;
  query?: URLSearchParams;
  body?: unknown;
  prefer?: string;
}): Promise<T> {
  const suffix = options.query ? `?${options.query.toString()}` : "";
  const response = await fetch(`${options.supabaseUrl}/rest/v1/${options.table}${suffix}`, {
    method: options.method,
    headers: {
      apikey: options.serviceKey,
      Authorization: `Bearer ${options.serviceKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const data = text.trim() ? (JSON.parse(text) as T) : ({} as T);

  if (!response.ok) {
    throw new Error(
      `Supabase ${options.method} ${options.table} failed (${response.status}): ${text}`,
    );
  }

  return data;
}

async function fetchDraft(
  supabaseUrl: string,
  serviceKey: string,
  table: string,
  draftId: string,
): Promise<DraftRecord | undefined> {
  const query = new URLSearchParams();
  query.set("select", "*");
  query.set("id", `eq.${draftId}`);
  query.set("limit", "1");

  const response = await supabaseRequest<unknown>({
    supabaseUrl,
    serviceKey,
    method: "GET",
    table,
    query,
  });

  if (!Array.isArray(response) || response.length === 0) {
    return undefined;
  }

  const row = getRecord(response[0]);
  if (!row || typeof row.id !== "string") {
    return undefined;
  }

  return {
    id: row.id,
    activity_id: typeof row.activity_id === "string" ? row.activity_id : undefined,
    account_email: typeof row.account_email === "string" ? row.account_email : undefined,
    to_email: typeof row.to_email === "string" ? row.to_email : undefined,
    subject: typeof row.subject === "string" ? row.subject : undefined,
    body: typeof row.body === "string" ? row.body : undefined,
    status: typeof row.status === "string" ? row.status : undefined,
    reply_to_message_id:
      typeof row.reply_to_message_id === "string" ? row.reply_to_message_id : undefined,
  };
}

async function fetchActivityMessageId(
  supabaseUrl: string,
  serviceKey: string,
  table: string,
  activityId: string,
): Promise<string | undefined> {
  const query = new URLSearchParams();
  query.set("select", "message_id");
  query.set("id", `eq.${activityId}`);
  query.set("limit", "1");

  const response = await supabaseRequest<unknown>({
    supabaseUrl,
    serviceKey,
    method: "GET",
    table,
    query,
  });

  if (!Array.isArray(response) || response.length === 0) {
    return undefined;
  }

  const row = getRecord(response[0]);
  const messageId = row?.message_id;
  return typeof messageId === "string" ? messageId : undefined;
}

async function patchDraft(
  supabaseUrl: string,
  serviceKey: string,
  table: string,
  draftId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const query = new URLSearchParams();
  query.set("id", `eq.${draftId}`);

  await supabaseRequest<unknown>({
    supabaseUrl,
    serviceKey,
    method: "PATCH",
    table,
    query,
    body: patch,
    prefer: "return=minimal",
  });
}

async function sendDraftEmail(args: {
  accountEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  replyToMessageId?: string;
}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "crm-draft-"));
  const bodyPath = path.join(tempDir, `${randomUUID()}.txt`);

  try {
    await writeFile(bodyPath, args.body, "utf8");
    const commandArgs = [
      "gmail",
      "send",
      "--account",
      args.accountEmail,
      "--to",
      args.toEmail,
      "--subject",
      args.subject,
      "--body-file",
      bodyPath,
      "--no-input",
    ];

    if (args.replyToMessageId) {
      commandArgs.push("--reply-to-message-id", args.replyToMessageId);
    }

    await execFileAsync("gog", commandArgs, { maxBuffer: 10 * 1024 * 1024 });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const { command, flags } = parseArgs(process.argv);
  if (command !== "approval_action") {
    console.error(
      "Usage: bun approval-action.ts approval_action --action <approve|revise|reject> --draft-id <id> [--approved-by <id>] [--notes <text>] [--reason <text>]",
    );
    process.exit(1);
  }

  const action = parseAction(asString(flags.action));
  if (!action) {
    throw new Error("--action must be one of: approve, revise, reject");
  }

  const draftId = clean(asString(flags["draft-id"]));
  if (!draftId) {
    throw new Error("--draft-id is required");
  }

  const approvedBy = clean(asString(flags["approved-by"]));
  const notes = clean(asString(flags.notes));
  const reason = clean(asString(flags.reason));

  const supabaseUrl = clean(process.env.SUPABASE_URL);
  const supabaseKey = clean(process.env.SUPABASE_SECRET_KEY);
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
  }

  const draftsTable = clean(process.env.CRM_DRAFTS_TABLE) || DEFAULT_DRAFTS_TABLE;
  const activitiesTable = clean(process.env.CRM_ACTIVITIES_TABLE) || DEFAULT_ACTIVITIES_TABLE;

  const draft = await fetchDraft(supabaseUrl, supabaseKey, draftsTable, draftId);
  if (!draft) {
    throw new Error(`Draft not found: ${draftId}`);
  }

  if (draft.status === "rejected" || draft.status === "sent") {
    const result: ActionResult = {
      command: "approval_action",
      action,
      draft_id: draftId,
      ok: false,
      message: `Draft is already ${draft.status}; no further action allowed.`,
      updated_status: draft.status,
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (action === "approve") {
    const accountEmail = draft.account_email || clean(process.env.GOG_ACCOUNT);
    const toEmail = draft.to_email;
    const subject = draft.subject;
    const body = draft.body;

    if (!accountEmail || !toEmail || !subject || !body) {
      throw new Error("Draft is missing account_email, to_email, subject, or body");
    }

    const replyToMessageId =
      draft.reply_to_message_id ||
      (draft.activity_id
        ? await fetchActivityMessageId(supabaseUrl, supabaseKey, activitiesTable, draft.activity_id)
        : undefined);

    await sendDraftEmail({
      accountEmail,
      toEmail,
      subject,
      body,
      replyToMessageId,
    });

    await patchDraft(supabaseUrl, supabaseKey, draftsTable, draftId, {
      status: "sent",
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result: ActionResult = {
      command: "approval_action",
      action,
      draft_id: draftId,
      ok: true,
      message: `Draft ${draftId} approved and sent.`,
      email_sent: true,
      updated_status: "sent",
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (action === "revise") {
    if (!notes) {
      throw new Error("--notes is required for action=revise");
    }

    const revisedBody = [draft.body ?? "", "", "[Revision requested]", notes].join("\n").trim();

    await patchDraft(supabaseUrl, supabaseKey, draftsTable, draftId, {
      status: "draft",
      revision_notes: notes,
      body: revisedBody,
      updated_at: new Date().toISOString(),
    });

    const result: ActionResult = {
      command: "approval_action",
      action,
      draft_id: draftId,
      ok: true,
      message: `Draft ${draftId} revised and ready for re-approval.`,
      updated_status: "draft",
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!reason) {
    throw new Error("--reason is required for action=reject");
  }

  await patchDraft(supabaseUrl, supabaseKey, draftsTable, draftId, {
    status: "rejected",
    rejected_reason: reason,
    rejected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const result: ActionResult = {
    command: "approval_action",
    action,
    draft_id: draftId,
    ok: true,
    message: `Draft ${draftId} rejected.`,
    updated_status: "rejected",
  };
  console.log(JSON.stringify(result, null, 2));
}

await main();
