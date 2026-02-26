import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type CliArgs = {
  command?: string;
  flags: Record<string, string | boolean>;
};

type DraftRow = {
  id: string;
  activity_id?: string;
  account_email?: string;
  to_email?: string;
  subject?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
};

type ActivityRow = {
  id: string;
  account_email?: string;
  from_email?: string;
  from_name?: string;
  subject?: string;
  received_at?: string;
  classification?: string;
  crm_drafts?: Array<{ id?: string; status?: string; updated_at?: string }> | null;
};

type SlackBlock = Record<string, unknown>;

type SlackMessage = {
  text: string;
  blocks?: SlackBlock[];
};

type OutstandingResult = {
  command: "check_outstanding";
  run_id: string;
  started_at: string;
  finished_at: string;
  lookback_days: number;
  stale_hours: number;
  totals: {
    unsent_drafts: number;
    stale_drafts: number;
    unanswered_sales_leads: number;
  };
  posted: boolean;
  post_error?: string;
  unsent_drafts: DraftRow[];
  stale_drafts: DraftRow[];
  unanswered_sales_leads: ActivityRow[];
};

const DEFAULT_OUTPUT_FILE = "/tmp/crm-outstanding.json";
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_STALE_HOURS = 24;
const DEFAULT_MAX_ROWS = 200;

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

function asNumber(value: string | boolean | undefined): number | undefined {
  const text = asString(value);
  if (!text) {
    return undefined;
  }
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asDraftRow(value: unknown): DraftRow | undefined {
  const row = getRecord(value);
  if (!row || typeof row.id !== "string") {
    return undefined;
  }

  return {
    id: row.id,
    activity_id: typeof row.activity_id === "string" ? row.activity_id : undefined,
    account_email: typeof row.account_email === "string" ? row.account_email : undefined,
    to_email: typeof row.to_email === "string" ? row.to_email : undefined,
    subject: typeof row.subject === "string" ? row.subject : undefined,
    status: typeof row.status === "string" ? row.status : undefined,
    created_at: typeof row.created_at === "string" ? row.created_at : undefined,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : undefined,
  };
}

function normalizeRelatedDrafts(
  value: unknown,
): Array<{ id?: string; status?: string; updated_at?: string }> {
  if (Array.isArray(value)) {
    return value
      .map((entry) => getRecord(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .map((entry) => ({
        id: typeof entry.id === "string" ? entry.id : undefined,
        status: typeof entry.status === "string" ? entry.status : undefined,
        updated_at: typeof entry.updated_at === "string" ? entry.updated_at : undefined,
      }));
  }

  const record = getRecord(value);
  if (!record) {
    return [];
  }

  return [
    {
      id: typeof record.id === "string" ? record.id : undefined,
      status: typeof record.status === "string" ? record.status : undefined,
      updated_at: typeof record.updated_at === "string" ? record.updated_at : undefined,
    },
  ];
}

function asActivityRow(value: unknown): ActivityRow | undefined {
  const row = getRecord(value);
  if (!row || typeof row.id !== "string") {
    return undefined;
  }

  return {
    id: row.id,
    account_email: typeof row.account_email === "string" ? row.account_email : undefined,
    from_email: typeof row.from_email === "string" ? row.from_email : undefined,
    from_name: typeof row.from_name === "string" ? row.from_name : undefined,
    subject: typeof row.subject === "string" ? row.subject : undefined,
    received_at: typeof row.received_at === "string" ? row.received_at : undefined,
    classification: typeof row.classification === "string" ? row.classification : undefined,
    crm_drafts: normalizeRelatedDrafts(row.crm_drafts),
  };
}

function includesAny(text: string, signals: string[]): boolean {
  return signals.some((signal) => text.includes(signal));
}

function isLikelyBusinessLead(activity: ActivityRow): boolean {
  const text =
    `${activity.subject ?? ""} ${activity.from_name ?? ""} ${activity.from_email ?? ""}`.toLowerCase();
  const fromEmail = (activity.from_email || "").toLowerCase();
  const senderLocal = fromEmail.includes("@") ? fromEmail.split("@")[0] || "" : "";
  const senderDomain = fromEmail.includes("@") ? fromEmail.split("@")[1] || "" : "";

  const automatedSenderSignals = [
    "no-reply",
    "noreply",
    "do-not-reply",
    "notifications",
    "digest",
    "newsletter",
    "jobalerts",
  ];
  const automatedTextSignals = [
    "job alert",
    "recommended jobs",
    "linkedin jobs",
    "daily digest",
    "weekly digest",
    "unsubscribe",
    "manage preferences",
  ];
  const blockedDomains = [
    "linkedin.com",
    "indeed.com",
    "glassdoor.com",
    "ziprecruiter.com",
    "monster.com",
    "mailchimp.com",
    "sendgrid.net",
    "stripe.com",
    "paypal.com",
    "intuit.com",
    "quickbooks.com",
  ];

  const leadSignals = [
    "consulting opportunity",
    "paid consulting",
    "consulting",
    "advisor",
    "advisory",
    "book a call",
    "request a quote",
    "proposal",
    "pricing",
    "sponsorship",
    "partnership",
    "alphasights",
    "guidepoint",
    "third bridge",
    "glg",
  ];

  const looksAutomated =
    includesAny(senderLocal, automatedSenderSignals) || includesAny(text, automatedTextSignals);
  if (looksAutomated || blockedDomains.includes(senderDomain)) {
    return false;
  }

  return includesAny(text, leadSignals);
}

async function supabaseRequest<T>(options: {
  supabaseUrl: string;
  serviceKey: string;
  table: string;
  query: URLSearchParams;
}): Promise<T> {
  const response = await fetch(
    `${options.supabaseUrl}/rest/v1/${options.table}?${options.query.toString()}`,
    {
      method: "GET",
      headers: {
        apikey: options.serviceKey,
        Authorization: `Bearer ${options.serviceKey}`,
        Accept: "application/json",
      },
    },
  );

  const text = await response.text();
  const body = text.trim() ? (JSON.parse(text) as T) : ([] as T);

  if (!response.ok) {
    throw new Error(`Supabase GET ${options.table} failed (${response.status}): ${text}`);
  }

  return body;
}

function ageHours(isoDate: string | undefined): number {
  if (!isoDate) {
    return 0;
  }
  const ts = Date.parse(isoDate);
  if (!Number.isFinite(ts)) {
    return 0;
  }
  return Math.max(0, Math.floor((Date.now() - ts) / 3_600_000));
}

function clamp(text: string | undefined, max = 90): string {
  if (!text) {
    return "(no subject)";
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function buildOutstandingSlackMessage(args: {
  lookbackDays: number;
  staleHours: number;
  staleDrafts: DraftRow[];
  unansweredLeads: ActivityRow[];
}): SlackMessage | undefined {
  if (args.staleDrafts.length === 0 && args.unansweredLeads.length === 0) {
    return undefined;
  }

  const stalePreview = args.staleDrafts
    .slice(0, 10)
    .map((draft) => {
      const age = ageHours(draft.updated_at || draft.created_at);
      const target = draft.to_email || "unknown";
      return `• \`${draft.id}\` • ${target} • ${clamp(draft.subject)} • ${age}h old`;
    })
    .join("\n");

  const unansweredPreview = args.unansweredLeads
    .slice(0, 10)
    .map((lead) => {
      const from = lead.from_email || lead.from_name || "unknown";
      const age = ageHours(lead.received_at);
      return `• \`${lead.id}\` • ${from} • ${clamp(lead.subject)} • ${age}h old`;
    })
    .join("\n");

  const text = [
    "CRM Outstanding Review",
    `Window: last ${args.lookbackDays} days`,
    `Stale drafts (>${args.staleHours}h): ${args.staleDrafts.length}`,
    `Unanswered sales leads: ${args.unansweredLeads.length}`,
    args.staleDrafts.length > 0 ? "\nStale drafts:\n" + stalePreview : "",
    args.unansweredLeads.length > 0 ? "\nUnanswered leads:\n" + unansweredPreview : "",
  ]
    .filter(Boolean)
    .join("\n");

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "CRM Outstanding Review",
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Window:*\nLast ${args.lookbackDays} days` },
        {
          type: "mrkdwn",
          text: `*Stale Drafts (>${args.staleHours}h):*\n${args.staleDrafts.length}`,
        },
        { type: "mrkdwn", text: `*Unanswered Sales Leads:*\n${args.unansweredLeads.length}` },
      ],
    },
  ];

  if (args.staleDrafts.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Stale Drafts*\n${stalePreview}`,
      },
    });
  }

  if (args.unansweredLeads.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Unanswered Sales Leads*\n${unansweredPreview}`,
      },
    });
  }

  return { text, blocks };
}

async function maybePostSlack(message: SlackMessage): Promise<{ posted: boolean; error?: string }> {
  const token = clean(process.env.SLACK_BOT_TOKEN);
  const channel =
    clean(process.env.CRM_SLACK_CHANNEL_ID) ||
    clean(process.env.SLACK_CHANNEL_ID) ||
    clean(process.env.CRM_SLACK_CHANNEL);

  if (!token || !channel) {
    return { posted: false, error: "CRM_SLACK_CHANNEL_ID or SLACK_BOT_TOKEN missing" };
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text: message.text,
      ...(Array.isArray(message.blocks) && message.blocks.length > 0
        ? { blocks: message.blocks }
        : {}),
      unfurl_links: false,
      unfurl_media: false,
    }),
  });

  const data = (await response.json()) as Record<string, unknown>;
  if (response.ok && data.ok === true) {
    return { posted: true };
  }

  const error = typeof data.error === "string" ? data.error : `slack-error-${response.status}`;
  return { posted: false, error };
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const { command, flags } = parseArgs(process.argv);
  if (command !== "check_outstanding") {
    console.error(
      "Usage: tsx check-outstanding.ts check_outstanding [--lookback-days <n>] [--stale-hours <n>] [--output <path>]",
    );
    process.exit(1);
  }

  const outputFile = clean(asString(flags.output)) || DEFAULT_OUTPUT_FILE;
  const lookbackDays =
    asNumber(flags["lookback-days"]) ||
    asNumber(process.env.CRM_OUTSTANDING_LOOKBACK_DAYS) ||
    DEFAULT_LOOKBACK_DAYS;
  const staleHours =
    asNumber(flags["stale-hours"]) ||
    asNumber(process.env.CRM_OUTSTANDING_STALE_HOURS) ||
    DEFAULT_STALE_HOURS;
  const maxRows = asNumber(flags.limit) || DEFAULT_MAX_ROWS;

  const supabaseUrl = clean(process.env.SUPABASE_URL);
  const supabaseKey = clean(process.env.SUPABASE_SECRET_KEY);
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
  }

  const sinceIso = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const startedAt = new Date().toISOString();

  const draftsQuery = new URLSearchParams();
  draftsQuery.set(
    "select",
    "id,activity_id,account_email,to_email,subject,status,created_at,updated_at",
  );
  draftsQuery.set("status", "eq.draft");
  draftsQuery.set("created_at", `gte.${sinceIso}`);
  draftsQuery.set("order", "updated_at.desc");
  draftsQuery.set("limit", String(maxRows));

  const rawDrafts = await supabaseRequest<unknown[]>({
    supabaseUrl,
    serviceKey: supabaseKey,
    table: "crm_drafts",
    query: draftsQuery,
  });
  const unsentDrafts = rawDrafts
    .map((row) => asDraftRow(row))
    .filter((row): row is DraftRow => Boolean(row));

  const activitiesQuery = new URLSearchParams();
  activitiesQuery.set(
    "select",
    "id,account_email,from_email,from_name,subject,received_at,classification,crm_drafts(id,status,updated_at)",
  );
  activitiesQuery.set("classification", "in.(sales,ignore)");
  activitiesQuery.set("received_at", `gte.${sinceIso}`);
  activitiesQuery.set("order", "received_at.desc");
  activitiesQuery.set("limit", String(maxRows));

  const rawActivities = await supabaseRequest<unknown[]>({
    supabaseUrl,
    serviceKey: supabaseKey,
    table: "crm_activities",
    query: activitiesQuery,
  });
  const salesActivities = rawActivities
    .map((row) => asActivityRow(row))
    .filter((row): row is ActivityRow => Boolean(row));

  const unansweredSalesLeads = salesActivities.filter((activity) => {
    if (!isLikelyBusinessLead(activity)) {
      return false;
    }
    const drafts = Array.isArray(activity.crm_drafts) ? activity.crm_drafts : [];
    return drafts.length === 0;
  });

  const staleDrafts = unsentDrafts.filter((draft) => {
    const baseTs = draft.updated_at || draft.created_at;
    return ageHours(baseTs) >= staleHours;
  });

  const slackMessage = buildOutstandingSlackMessage({
    lookbackDays,
    staleHours,
    staleDrafts,
    unansweredLeads: unansweredSalesLeads,
  });

  let posted = false;
  let postError: string | undefined;
  if (slackMessage) {
    const postedResult = await maybePostSlack(slackMessage);
    posted = postedResult.posted;
    postError = postedResult.error;
  }

  const result: OutstandingResult = {
    command: "check_outstanding",
    run_id: randomUUID(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    lookback_days: lookbackDays,
    stale_hours: staleHours,
    totals: {
      unsent_drafts: unsentDrafts.length,
      stale_drafts: staleDrafts.length,
      unanswered_sales_leads: unansweredSalesLeads.length,
    },
    posted,
    ...(postError ? { post_error: postError } : {}),
    unsent_drafts: unsentDrafts,
    stale_drafts: staleDrafts,
    unanswered_sales_leads: unansweredSalesLeads,
  };

  await writeJson(outputFile, result);
  console.log(JSON.stringify(result, null, 2));
}

await main();
