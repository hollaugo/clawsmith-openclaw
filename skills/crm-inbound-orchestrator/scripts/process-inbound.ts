import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type CliArgs = {
  command?: string;
  flags: Record<string, string | boolean>;
};

type Classification = "receipt" | "sales" | "support" | "ignore";

type PollMessage = {
  account_email: string;
  message_id: string;
  thread_id?: string;
  subject?: string;
  from?: string;
  snippet?: string;
  received_at?: string;
  internal_ts?: number;
  source_key: string;
  raw?: Record<string, unknown>;
};

type PollFile = {
  run_id?: string;
  started_at?: string;
  finished_at?: string;
  partial_failure?: boolean;
  messages: PollMessage[];
  per_account?: Array<{ account_email: string; fetched_count?: number; error?: string }>;
};

type SopSnapshot = {
  degraded?: boolean;
  source?: string;
  warnings?: string[];
  sop?: {
    hash?: string;
    sections?: Array<{ heading?: string; items?: string[] }>;
    blocks?: Array<{ text?: string }>;
  };
};

type ClassificationResult = {
  label: Classification;
  confidence: number;
  reasons: string[];
};

type ContactRow = {
  id: string;
  email: string;
  display_name?: string;
};

type ActivityRow = {
  id: string;
  source_key: string;
  account_email: string;
  message_id: string;
};

type DraftRow = {
  id: string;
  activity_id: string;
  account_email: string;
  to_email: string;
  subject: string;
  body: string;
};

type ProcessResult = {
  command: "process_inbound";
  run_id: string;
  started_at: string;
  finished_at: string;
  status: "ok" | "partial_failure";
  degraded: boolean;
  totals: {
    polled_messages: number;
    processed_messages: number;
    activities_upserted: number;
    drafts_upserted: number;
    accounting_entries_upserted: number;
  };
  classification_counts: Record<Classification, number>;
  sales_drafts: Array<{
    draft_id: string;
    activity_id: string;
    account_email: string;
    to_email: string;
    slack_posted: boolean;
    slack_error?: string;
  }>;
  accounting_entries: Array<{
    activity_id: string;
    source_key: string;
    vendor?: string;
    amount?: number;
    currency?: string;
  }>;
  poll_state_updates: Array<{
    account_email: string;
    last_polled_at: string;
    last_message_ts?: string;
  }>;
  warnings: string[];
};

type SlackBlock = Record<string, unknown>;

type SlackMessage = {
  text: string;
  blocks?: SlackBlock[];
};

const DEFAULT_SOP_CACHE_FILE = "/tmp/crm-inbound-sop-cache.json";
const DEFAULT_OUTPUT_FILE = "/tmp/crm-process.json";
const DEFAULT_CONTACTS_TABLE = "crm_contacts";
const DEFAULT_ACTIVITIES_TABLE = "crm_activities";
const DEFAULT_DRAFTS_TABLE = "crm_drafts";
const DEFAULT_ACCOUNTING_TABLE = "accounting_entries";
const DEFAULT_JOB_RUNS_TABLE = "crm_job_runs";
const DEFAULT_POLL_STATE_TABLE = "crm_poll_state";
const APPROVAL_HELP = [
  "Approve: /skill crm-inbound-orchestrator approve <draft_id>",
  "Revise: /skill crm-inbound-orchestrator revise <draft_id> <notes>",
  "Reject: /skill crm-inbound-orchestrator reject <draft_id> <reason>",
].join("\n");

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

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function supabaseRequest<T>(options: {
  supabaseUrl: string;
  serviceKey: string;
  method: "GET" | "POST" | "PATCH";
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

async function supabaseUpsertRow(
  options: {
    supabaseUrl: string;
    serviceKey: string;
    table: string;
    onConflict: string;
  },
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams();
  query.set("on_conflict", options.onConflict);

  const response = await supabaseRequest<unknown>({
    supabaseUrl: options.supabaseUrl,
    serviceKey: options.serviceKey,
    method: "POST",
    table: options.table,
    query,
    body: [row],
    prefer: "resolution=merge-duplicates,return=representation",
  });

  if (!Array.isArray(response) || response.length === 0) {
    return row;
  }

  return getRecord(response[0]) ?? row;
}

async function supabasePatchRows(
  options: {
    supabaseUrl: string;
    serviceKey: string;
    table: string;
    filters: Record<string, string>;
  },
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const query = new URLSearchParams();
  query.set("select", "*");
  for (const [key, value] of Object.entries(options.filters)) {
    query.set(key, `eq.${value}`);
  }

  const response = await supabaseRequest<unknown>({
    supabaseUrl: options.supabaseUrl,
    serviceKey: options.serviceKey,
    method: "PATCH",
    table: options.table,
    query,
    body: patch,
    prefer: "return=representation",
  });

  if (!Array.isArray(response)) {
    return [];
  }

  return response
    .map((item) => getRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function extractEmailAddress(rawFrom: string | undefined): string | undefined {
  if (!rawFrom) {
    return undefined;
  }

  const bracketMatch = rawFrom.match(/<([^>]+)>/);
  if (bracketMatch?.[1]) {
    return bracketMatch[1].trim().toLowerCase();
  }

  const bareMatch = rawFrom.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return bareMatch?.[0]?.toLowerCase();
}

function extractEmailDomain(email: string | undefined): string | undefined {
  if (!email || !email.includes("@")) {
    return undefined;
  }
  const domain = email.split("@")[1]?.trim().toLowerCase();
  return domain || undefined;
}

function includesAny(text: string, signals: string[]): boolean {
  return signals.some((signal) => text.includes(signal));
}

function extractDisplayName(rawFrom: string | undefined): string | undefined {
  if (!rawFrom) {
    return undefined;
  }

  const withoutEmail = rawFrom
    .replace(/<[^>]+>/g, "")
    .replace(/\"/g, "")
    .trim();
  return withoutEmail || undefined;
}

function classifyInbound(message: PollMessage): ClassificationResult {
  const text =
    `${message.subject ?? ""} ${message.snippet ?? ""} ${message.from ?? ""}`.toLowerCase();
  const reasons: string[] = [];
  const senderEmail = extractEmailAddress(message.from);
  const senderDomain = extractEmailDomain(senderEmail);

  const directInquirySignals = [
    "i'm interested",
    "i am interested",
    "we are interested",
    "sponsorship inquiry",
    "consulting",
    "consultation",
    "advisor",
    "advisory",
    "fractional",
    "retainer",
    "can we",
    "could we",
    "book a call",
    "request a quote",
    "proposal",
    "pricing",
    "need help",
    "looking for",
  ];
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
    "jobs you may be interested",
    "recommended jobs",
    "linkedin jobs",
    "daily digest",
    "weekly digest",
    "unsubscribe",
    "manage preferences",
  ];
  const hiringSignals = [
    "hiring",
    "job opening",
    "apply now",
    "application",
    "recruiter",
    "career opportunity",
    "open role",
    "resume",
  ];
  const vendorSystemDomains = [
    "linkedin.com",
    "indeed.com",
    "glassdoor.com",
    "ziprecruiter.com",
    "monster.com",
    "mail.linkedin.com",
    "mailchimp.com",
    "sendgrid.net",
    "stripe.com",
    "paypal.com",
    "quickbooks.com",
    "intuit.com",
  ];
  const jobNetworkDomains = [
    "linkedin.com",
    "indeed.com",
    "glassdoor.com",
    "ziprecruiter.com",
    "monster.com",
  ];

  const hasDirectInquiry = includesAny(text, directInquirySignals);
  const senderLocal = senderEmail?.split("@")[0]?.trim().toLowerCase() || "";
  const looksAutomated =
    includesAny(senderLocal, automatedSenderSignals) ||
    includesAny(text, automatedTextSignals) ||
    includesAny(text, automatedSenderSignals);
  const looksHiring = includesAny(text, hiringSignals);
  const fromJobNetwork = Boolean(senderDomain && jobNetworkDomains.includes(senderDomain));
  const fromVendorSystem = Boolean(senderDomain && vendorSystemDomains.includes(senderDomain));
  const likelyNonHumanSender = looksAutomated || fromJobNetwork || fromVendorSystem;

  if ((likelyNonHumanSender || looksHiring) && !hasDirectInquiry) {
    reasons.push("non-business-automation-filter");
    return { label: "ignore", confidence: 0.94, reasons };
  }

  const receiptSignals = [
    "invoice",
    "receipt",
    "payment",
    "charged",
    "charge",
    "order #",
    "order confirmation",
    "billing",
    "subscription",
    "tax invoice",
  ];
  const salesSignals = [
    "sponsorship",
    "partnership",
    "proposal",
    "quote",
    "pricing",
    "demo",
    "interested",
    "book a call",
    "campaign",
    "collaboration",
  ];
  const supportSignals = ["support", "help", "issue", "error", "problem", "unable", "bug"];
  const ignoreSignals = [
    "unsubscribe",
    "newsletter",
    "promo",
    "promotion",
    "digest",
    "marketing update",
  ];

  const countSignals = (signals: string[]) =>
    signals.reduce((count, signal) => (text.includes(signal) ? count + 1 : count), 0);

  const receiptScore = countSignals(receiptSignals);
  const salesScore = countSignals(salesSignals);
  const supportScore = countSignals(supportSignals);
  const ignoreScore = countSignals(ignoreSignals);

  if (receiptScore > 0 && receiptScore >= salesScore) {
    reasons.push("matched-receipt-signals");
    return { label: "receipt", confidence: Math.min(0.65 + receiptScore * 0.08, 0.96), reasons };
  }

  if (salesScore > 0) {
    if (!hasDirectInquiry || likelyNonHumanSender || looksHiring) {
      reasons.push("sales-needs-human-direct-inquiry");
      return { label: "ignore", confidence: 0.9, reasons };
    }
    reasons.push("matched-sales-signals");
    return { label: "sales", confidence: Math.min(0.62 + salesScore * 0.07, 0.95), reasons };
  }

  if (supportScore > 0) {
    reasons.push("matched-support-signals");
    return { label: "support", confidence: Math.min(0.58 + supportScore * 0.08, 0.9), reasons };
  }

  if (ignoreScore > 0) {
    reasons.push("matched-ignore-signals");
    return { label: "ignore", confidence: Math.min(0.6 + ignoreScore * 0.08, 0.92), reasons };
  }

  reasons.push("no-strong-signal");
  return { label: "ignore", confidence: 0.52, reasons };
}

function pickSopCues(sop: SopSnapshot | undefined): string[] {
  const lines: string[] = [];

  const sections = sop?.sop?.sections;
  if (Array.isArray(sections)) {
    for (const section of sections) {
      if (!section || typeof section !== "object") {
        continue;
      }
      const heading = typeof section.heading === "string" ? section.heading.trim() : "";
      if (heading) {
        lines.push(heading);
      }
      const items = Array.isArray(section.items) ? section.items : [];
      for (const item of items) {
        if (typeof item === "string" && item.trim()) {
          lines.push(item.trim());
        }
      }
    }
  }

  if (lines.length === 0 && Array.isArray(sop?.sop?.blocks)) {
    for (const block of sop.sop.blocks) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const text = (block as { text?: string }).text;
      if (typeof text === "string" && text.trim()) {
        lines.push(text.trim());
      }
    }
  }

  const useful = lines.filter((line) => {
    const lower = line.toLowerCase();
    return (
      lower.includes("qualif") ||
      lower.includes("response") ||
      lower.includes("lead") ||
      lower.includes("sponsor") ||
      lower.includes("timeline") ||
      lower.includes("pricing")
    );
  });

  return Array.from(new Set(useful)).slice(0, 6);
}

function firstNameFromDisplay(display: string | undefined): string {
  if (!display) {
    return "there";
  }
  const cleanDisplay = display.replace(/[^A-Za-z\s-]/g, " ").trim();
  if (!cleanDisplay) {
    return "there";
  }
  return cleanDisplay.split(/\s+/)[0] || "there";
}

function buildSalesDraft(args: {
  senderDisplayName?: string;
  senderEmail?: string;
  subject?: string;
  snippet?: string;
  sopCues: string[];
}): { subject: string; body: string } {
  const firstName = firstNameFromDisplay(args.senderDisplayName);
  const intentSnippet = args.snippet?.trim() || "Thanks for reaching out to Prompt Circle.";
  const sopNote =
    args.sopCues.length > 0
      ? args.sopCues.map((cue) => `- ${cue}`).join("\n")
      : "- Confirm fit and desired outcome\n- Provide next-step CTA";

  const subject = args.subject?.toLowerCase().startsWith("re:")
    ? args.subject
    : `Re: ${args.subject ?? "Prompt Circle inquiry"}`;

  const body = [
    `Hi ${firstName},`,
    "",
    "Thanks for your message.",
    intentSnippet,
    "",
    "To make this actionable, could you share:",
    "1) Your primary objective",
    "2) Timeline",
    "3) Budget range or decision criteria",
    "",
    "Once we have those details, I can send a concrete recommendation and next steps.",
    "",
    "Best,",
    "Prompt Circle",
    "",
    "[SOP cues used for this draft]",
    sopNote,
  ].join("\n");

  return { subject, body };
}

function parseReceiptInfo(message: PollMessage): {
  vendor?: string;
  amount?: number;
  currency?: string;
  receipt_date?: string;
} {
  const fromEmail = extractEmailAddress(message.from);
  const vendor = fromEmail?.split("@")[0] || extractDisplayName(message.from);
  const text = `${message.subject ?? ""} ${message.snippet ?? ""}`;

  let amount: number | undefined;
  let currency: string | undefined;

  const symbolMatch = text.match(/([$€£])\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/);
  if (symbolMatch?.[2]) {
    amount = Number.parseFloat(symbolMatch[2].replace(/,/g, ""));
    const symbol = symbolMatch[1];
    currency = symbol === "$" ? "USD" : symbol === "€" ? "EUR" : symbol === "£" ? "GBP" : undefined;
  } else {
    const codeMatch = text.match(/\b(USD|EUR|GBP|NGN|CAD|AUD)\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/i);
    if (codeMatch?.[2]) {
      amount = Number.parseFloat(codeMatch[2].replace(/,/g, ""));
      currency = codeMatch[1].toUpperCase();
    }
  }

  const receiptDate =
    message.received_at ||
    (message.internal_ts ? new Date(message.internal_ts).toISOString() : undefined);

  return {
    vendor,
    amount: Number.isFinite(amount ?? Number.NaN) ? amount : undefined,
    currency,
    receipt_date: receiptDate,
  };
}

function formatSlackWhen(isoDate: string | undefined): string {
  if (!isoDate) {
    return "n/a";
  }
  const ms = Date.parse(isoDate);
  if (!Number.isFinite(ms)) {
    return isoDate;
  }
  return `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} {time}|${isoDate}>`;
}

function buildDraftSlackMessage(args: {
  draftId: string;
  toEmail: string;
  fromName?: string;
  fromEmail?: string;
  accountEmail: string;
  subject: string;
  receivedAt?: string;
}): SlackMessage {
  const to = args.toEmail;
  const from = args.fromEmail || args.fromName || "unknown";
  const when = formatSlackWhen(args.receivedAt);
  const approvalCommands = APPROVAL_HELP.replace(/<draft_id>/g, args.draftId);

  const text = [
    `CRM lead draft ready`,
    `Draft ID: ${args.draftId}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${args.subject}`,
    `Received: ${when}`,
    "",
    approvalCommands,
  ].join("\n");

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "CRM Lead Draft Ready",
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Draft ID:*\n\`${args.draftId}\`` },
        { type: "mrkdwn", text: `*Mailbox:*\n${args.accountEmail}` },
        { type: "mrkdwn", text: `*From:*\n${from}` },
        { type: "mrkdwn", text: `*To:*\n${to}` },
        { type: "mrkdwn", text: `*Received:*\n${when}` },
        { type: "mrkdwn", text: `*Subject:*\n${args.subject}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Approval Commands*\n\`\`\`${approvalCommands}\`\`\``,
      },
    },
  ];

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

async function loadSopSnapshot(pathOverride?: string): Promise<SopSnapshot | undefined> {
  const sopFile = pathOverride || clean(process.env.CRM_SOP_CACHE_FILE) || DEFAULT_SOP_CACHE_FILE;
  try {
    return await readJsonFile<SopSnapshot>(sopFile);
  } catch {
    return undefined;
  }
}

async function main() {
  const { command, flags } = parseArgs(process.argv);
  if (command !== "process_inbound") {
    console.error(
      "Usage: bun process-inbound.ts process_inbound --poll-file <path> [--sop-file <path>] [--output <path>]",
    );
    process.exit(1);
  }

  const pollFile = clean(asString(flags["poll-file"]));
  if (!pollFile) {
    throw new Error("--poll-file is required");
  }

  const outputFile = clean(asString(flags.output)) || DEFAULT_OUTPUT_FILE;
  const sopFile = clean(asString(flags["sop-file"]));

  const supabaseUrl = clean(process.env.SUPABASE_URL);
  const supabaseKey = clean(process.env.SUPABASE_SECRET_KEY);
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
  }

  const contactsTable = clean(process.env.CRM_CONTACTS_TABLE) || DEFAULT_CONTACTS_TABLE;
  const activitiesTable = clean(process.env.CRM_ACTIVITIES_TABLE) || DEFAULT_ACTIVITIES_TABLE;
  const draftsTable = clean(process.env.CRM_DRAFTS_TABLE) || DEFAULT_DRAFTS_TABLE;
  const accountingTable = clean(process.env.CRM_ACCOUNTING_TABLE) || DEFAULT_ACCOUNTING_TABLE;
  const jobRunsTable = clean(process.env.CRM_JOB_RUNS_TABLE) || DEFAULT_JOB_RUNS_TABLE;
  const pollStateTable = clean(process.env.CRM_POLL_STATE_TABLE) || DEFAULT_POLL_STATE_TABLE;

  const startedAt = new Date().toISOString();
  const poll = await readJsonFile<PollFile>(pollFile);
  const sop = await loadSopSnapshot(sopFile);
  const sopCues = pickSopCues(sop);

  const runId = poll.run_id || randomUUID();

  await supabaseUpsertRow(
    {
      supabaseUrl,
      serviceKey: supabaseKey,
      table: jobRunsTable,
      onConflict: "id",
    },
    {
      id: runId,
      started_at: poll.started_at || startedAt,
      status: "running",
      degraded: sop?.degraded === true,
      poll_partial_failure: poll.partial_failure === true,
      metrics: {
        polled_messages: poll.messages.length,
      },
      accounts: poll.per_account ?? [],
      updated_at: new Date().toISOString(),
    },
  );

  const result: ProcessResult = {
    command: "process_inbound",
    run_id: runId,
    started_at: startedAt,
    finished_at: "",
    status: "ok",
    degraded: sop?.degraded === true,
    totals: {
      polled_messages: poll.messages.length,
      processed_messages: 0,
      activities_upserted: 0,
      drafts_upserted: 0,
      accounting_entries_upserted: 0,
    },
    classification_counts: {
      receipt: 0,
      sales: 0,
      support: 0,
      ignore: 0,
    },
    sales_drafts: [],
    accounting_entries: [],
    poll_state_updates: [],
    warnings: [],
  };

  if (sop?.degraded) {
    result.warnings.push(...(sop.warnings ?? []));
  }
  if (!sop) {
    result.warnings.push("No SOP snapshot found; continuing with default routing behavior.");
  }

  const maxTsByAccount = new Map<string, string>();

  for (const message of poll.messages) {
    const classification = classifyInbound(message);
    result.classification_counts[classification.label] += 1;

    const senderEmail = extractEmailAddress(message.from);
    const senderName = extractDisplayName(message.from);
    const messageTs =
      message.received_at ||
      (message.internal_ts ? new Date(message.internal_ts).toISOString() : undefined);

    if (messageTs) {
      const prior = maxTsByAccount.get(message.account_email);
      if (!prior || Date.parse(messageTs) > Date.parse(prior)) {
        maxTsByAccount.set(message.account_email, messageTs);
      }
    }

    let contactId: string | undefined;
    if (senderEmail && (classification.label === "sales" || classification.label === "support")) {
      const contact = await supabaseUpsertRow(
        {
          supabaseUrl,
          serviceKey: supabaseKey,
          table: contactsTable,
          onConflict: "email",
        },
        {
          email: senderEmail,
          display_name: senderName,
          last_seen_at: messageTs || new Date().toISOString(),
          source_account_email: message.account_email,
          updated_at: new Date().toISOString(),
        },
      );

      contactId = typeof contact.id === "string" ? contact.id : undefined;
    }

    const activityPayload: Record<string, unknown> = {
      source_key: message.source_key,
      account_email: message.account_email,
      message_id: message.message_id,
      thread_id: message.thread_id,
      from_raw: message.from,
      from_email: senderEmail,
      from_name: senderName,
      subject: message.subject,
      snippet: message.snippet,
      received_at: messageTs,
      classification: classification.label,
      classification_confidence: classification.confidence,
      classification_reasons: classification.reasons,
      contact_id: contactId,
      contact_email: senderEmail,
      sop_hash: sop?.sop?.hash,
      payload: message.raw ?? {},
      updated_at: new Date().toISOString(),
    };

    const activity = await supabaseUpsertRow(
      {
        supabaseUrl,
        serviceKey: supabaseKey,
        table: activitiesTable,
        onConflict: "source_key",
      },
      activityPayload,
    );

    const activityId = typeof activity.id === "string" ? activity.id : undefined;
    if (!activityId) {
      throw new Error(`Missing activity id after upsert for source_key=${message.source_key}`);
    }
    result.totals.activities_upserted += 1;

    if (classification.label === "sales") {
      const draft = buildSalesDraft({
        senderDisplayName: senderName,
        senderEmail,
        subject: message.subject,
        snippet: message.snippet,
        sopCues,
      });

      const toEmail = senderEmail || "unknown@example.com";
      const draftRow = await supabaseUpsertRow(
        {
          supabaseUrl,
          serviceKey: supabaseKey,
          table: draftsTable,
          onConflict: "activity_id",
        },
        {
          activity_id: activityId,
          account_email: message.account_email,
          to_email: toEmail,
          subject: draft.subject,
          body: draft.body,
          status: "draft",
          approval_commands: APPROVAL_HELP,
          reply_to_message_id: message.message_id,
          sop_hash: sop?.sop?.hash,
          updated_at: new Date().toISOString(),
        },
      );

      const draftId = typeof draftRow.id === "string" ? draftRow.id : undefined;
      if (!draftId) {
        throw new Error(`Missing draft id after upsert for activity_id=${activityId}`);
      }
      const slackMessage = buildDraftSlackMessage({
        draftId,
        toEmail,
        fromName: senderName,
        fromEmail: senderEmail,
        accountEmail: message.account_email,
        subject: draft.subject,
        receivedAt: messageTs,
      });

      await supabasePatchRows(
        {
          supabaseUrl,
          serviceKey: supabaseKey,
          table: draftsTable,
          filters: { id: draftId },
        },
        {
          slack_summary: slackMessage.text,
          updated_at: new Date().toISOString(),
        },
      );

      const slack = await maybePostSlack(slackMessage);
      result.sales_drafts.push({
        draft_id: draftId,
        activity_id: activityId,
        account_email: message.account_email,
        to_email: toEmail,
        slack_posted: slack.posted,
        slack_error: slack.error,
      });
      result.totals.drafts_upserted += 1;
    }

    if (classification.label === "receipt") {
      const parsed = parseReceiptInfo(message);

      await supabaseUpsertRow(
        {
          supabaseUrl,
          serviceKey: supabaseKey,
          table: accountingTable,
          onConflict: "source_key",
        },
        {
          source_key: message.source_key,
          activity_id: activityId,
          account_email: message.account_email,
          vendor: parsed.vendor,
          amount: parsed.amount,
          currency: parsed.currency,
          receipt_date: parsed.receipt_date,
          subject: message.subject,
          snippet: message.snippet,
          payload: message.raw ?? {},
          updated_at: new Date().toISOString(),
        },
      );

      result.accounting_entries.push({
        activity_id: activityId,
        source_key: message.source_key,
        vendor: parsed.vendor,
        amount: parsed.amount,
        currency: parsed.currency,
      });
      result.totals.accounting_entries_upserted += 1;
    }

    result.totals.processed_messages += 1;
  }

  const accountSet = new Set<string>();
  for (const message of poll.messages) {
    accountSet.add(message.account_email);
  }
  for (const entry of poll.per_account ?? []) {
    if (entry.account_email) {
      accountSet.add(entry.account_email);
    }
  }

  for (const accountEmail of accountSet) {
    const stateRow = {
      account_email: accountEmail,
      last_polled_at: new Date().toISOString(),
      last_message_ts: maxTsByAccount.get(accountEmail),
      updated_at: new Date().toISOString(),
    };

    await supabaseUpsertRow(
      {
        supabaseUrl,
        serviceKey: supabaseKey,
        table: pollStateTable,
        onConflict: "account_email",
      },
      stateRow,
    );

    result.poll_state_updates.push({
      account_email: accountEmail,
      last_polled_at: stateRow.last_polled_at,
      last_message_ts: stateRow.last_message_ts,
    });
  }

  if (poll.partial_failure || result.sales_drafts.some((entry) => !entry.slack_posted)) {
    result.status = "partial_failure";
  }

  result.finished_at = new Date().toISOString();

  await supabasePatchRows(
    {
      supabaseUrl,
      serviceKey: supabaseKey,
      table: jobRunsTable,
      filters: { id: runId },
    },
    {
      finished_at: result.finished_at,
      status: result.status,
      degraded: result.degraded,
      metrics: {
        polled_messages: result.totals.polled_messages,
        processed_messages: result.totals.processed_messages,
        activities_upserted: result.totals.activities_upserted,
        drafts_upserted: result.totals.drafts_upserted,
        accounting_entries_upserted: result.totals.accounting_entries_upserted,
      },
      warnings: result.warnings,
      updated_at: new Date().toISOString(),
    },
  );

  await writeJson(outputFile, result);
  console.log(JSON.stringify(result, null, 2));
}

await main();
