import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

type CliArgs = {
  command?: string;
  flags: Record<string, string | boolean>;
};

type PollStateRow = {
  account_email: string;
  last_polled_at?: string;
  last_message_ts?: string;
  updated_at?: string;
};

type GmailMessage = {
  account_email: string;
  message_id: string;
  thread_id?: string;
  subject?: string;
  from?: string;
  snippet?: string;
  received_at?: string;
  internal_ts?: number;
  source_key: string;
  raw: Record<string, unknown>;
};

type AccountPollResult = {
  account_email: string;
  query: string;
  since_ts: string;
  fetched_count: number;
  error?: string;
};

type PollOutput = {
  command: "poll_inboxes";
  run_id: string;
  started_at: string;
  finished_at: string;
  poll_query: string;
  overlap_minutes: number;
  max_results: number;
  per_account: AccountPollResult[];
  partial_failure: boolean;
  total_messages: number;
  messages: GmailMessage[];
};

const execFileAsync = promisify(execFile);
const DEFAULT_POLL_QUERY = "in:inbox -in:spam -in:trash";
const DEFAULT_OVERLAP_MINUTES = 120;
const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_POLL_STATE_TABLE = "crm_poll_state";
const DEFAULT_OUTPUT = "/tmp/crm-poll.json";

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

function parseEmails(value: string | undefined): string[] {
  const text = clean(value);
  if (!text) {
    return [];
  }
  return text
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function getEpochMillis(record: Record<string, unknown>): number | undefined {
  const candidates = [record.internalDate, record.internal_date, record.receivedAt, record.date];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      if (candidate > 1_000_000_000_000) {
        return candidate;
      }
      if (candidate > 1_000_000_000) {
        return candidate * 1000;
      }
    }
    if (typeof candidate === "string" && candidate.trim()) {
      if (/^\d+$/.test(candidate.trim())) {
        const parsed = Number.parseInt(candidate.trim(), 10);
        if (Number.isFinite(parsed)) {
          if (parsed > 1_000_000_000_000) {
            return parsed;
          }
          if (parsed > 1_000_000_000) {
            return parsed * 1000;
          }
        }
      }
      const parsedDate = Date.parse(candidate);
      if (Number.isFinite(parsedDate)) {
        return parsedDate;
      }
    }
  }
  return undefined;
}

function parseGogMessages(rawJson: string): Record<string, unknown>[] {
  const parsed = JSON.parse(rawJson) as unknown;

  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is Record<string, unknown> => Boolean(getRecord(item)));
  }

  const record = getRecord(parsed);
  if (!record) {
    return [];
  }

  const listCandidates = [
    record.messages,
    record.items,
    record.data,
    record.results,
    record.rows,
    record.threads,
  ];

  for (const candidate of listCandidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    return candidate.filter((item): item is Record<string, unknown> => Boolean(getRecord(item)));
  }

  return [];
}

async function runGogMessageSearch(args: {
  account: string;
  query: string;
  maxResults: number;
}): Promise<Record<string, unknown>[]> {
  const commandArgs = [
    "gmail",
    "messages",
    "search",
    args.query,
    "--max",
    String(args.maxResults),
    "--account",
    args.account,
    "--json",
    "--no-input",
  ];

  const { stdout } = await execFileAsync("gog", commandArgs, {
    maxBuffer: 15 * 1024 * 1024,
  });

  return parseGogMessages(stdout);
}

async function supabaseSelectPollState(options: {
  supabaseUrl: string;
  serviceKey: string;
  table: string;
  accountEmail: string;
}): Promise<PollStateRow | undefined> {
  const query = new URLSearchParams();
  query.set("select", "account_email,last_polled_at,last_message_ts,updated_at");
  query.set("account_email", `eq.${options.accountEmail}`);
  query.set("limit", "1");

  const response = await fetch(
    `${options.supabaseUrl}/rest/v1/${options.table}?${query.toString()}`,
    {
      headers: {
        apikey: options.serviceKey,
        Authorization: `Bearer ${options.serviceKey}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase poll state read failed (${response.status}): ${text || "unknown"}`);
  }

  const body = (await response.json()) as unknown;
  if (!Array.isArray(body) || body.length === 0) {
    return undefined;
  }

  const row = getRecord(body[0]);
  if (!row) {
    return undefined;
  }

  return {
    account_email: String(row.account_email ?? options.accountEmail),
    last_polled_at: typeof row.last_polled_at === "string" ? row.last_polled_at : undefined,
    last_message_ts: typeof row.last_message_ts === "string" ? row.last_message_ts : undefined,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : undefined,
  };
}

function buildSinceEpochSeconds(state: PollStateRow | undefined, overlapMinutes: number): number {
  const overlapMs = overlapMinutes * 60_000;
  const now = Date.now();

  if (!state?.last_message_ts) {
    return Math.floor((now - overlapMs) / 1000);
  }

  const parsed = Date.parse(state.last_message_ts);
  if (!Number.isFinite(parsed)) {
    return Math.floor((now - overlapMs) / 1000);
  }

  const sinceMs = Math.max(parsed - overlapMs, 0);
  return Math.floor(sinceMs / 1000);
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeMessage(account: string, raw: Record<string, unknown>): GmailMessage | undefined {
  const messageId = getString(raw, ["id", "messageId", "message_id"]);
  if (!messageId) {
    return undefined;
  }

  const threadId = getString(raw, ["threadId", "thread_id"]);
  const subject = getString(raw, ["subject"]);
  const from = getString(raw, ["from", "sender"]);
  const snippet = getString(raw, ["snippet", "preview", "bodySnippet"]);
  const internalTs = getEpochMillis(raw);

  return {
    account_email: account,
    message_id: messageId,
    thread_id: threadId,
    subject,
    from,
    snippet,
    received_at: internalTs ? new Date(internalTs).toISOString() : undefined,
    internal_ts: internalTs,
    source_key: `${account}:${messageId}`,
    raw,
  };
}

async function main() {
  const { command, flags } = parseArgs(process.argv);
  if (command !== "poll_inboxes") {
    console.error(
      "Usage: bun poll-inboxes.ts poll_inboxes [--accounts <csv>] [--query <gmail-query>] [--overlap-minutes <n>] [--output <path>]",
    );
    process.exit(1);
  }

  const accounts = parseEmails(asString(flags.accounts) || process.env.CRM_MONITORED_EMAILS);
  if (accounts.length === 0) {
    throw new Error("CRM_MONITORED_EMAILS is required (comma-separated)");
  }

  const pollQuery =
    clean(asString(flags.query)) || clean(process.env.CRM_POLL_QUERY) || DEFAULT_POLL_QUERY;
  const overlapMinutes =
    asNumber(flags["overlap-minutes"]) ||
    asNumber(process.env.CRM_POLL_OVERLAP_MINUTES) ||
    DEFAULT_OVERLAP_MINUTES;
  const maxResults =
    asNumber(flags["max-results"]) ||
    asNumber(process.env.CRM_POLL_MAX_RESULTS) ||
    DEFAULT_MAX_RESULTS;
  const outputPath = clean(asString(flags.output)) || DEFAULT_OUTPUT;

  const supabaseUrl = clean(process.env.SUPABASE_URL);
  const supabaseKey = clean(process.env.SUPABASE_SECRET_KEY);
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
  }

  const pollStateTable = clean(process.env.CRM_POLL_STATE_TABLE) || DEFAULT_POLL_STATE_TABLE;

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const perAccount: AccountPollResult[] = [];
  const allMessages: GmailMessage[] = [];

  for (const account of accounts) {
    try {
      const state = await supabaseSelectPollState({
        supabaseUrl,
        serviceKey: supabaseKey,
        table: pollStateTable,
        accountEmail: account,
      });

      const sinceEpoch = buildSinceEpochSeconds(state, overlapMinutes);
      const accountQuery = `${pollQuery} after:${sinceEpoch}`;

      const rows = await runGogMessageSearch({
        account,
        query: accountQuery,
        maxResults,
      });

      const normalized = rows
        .map((row) => normalizeMessage(account, row))
        .filter((message): message is GmailMessage => Boolean(message));

      const seen = new Set<string>();
      const deduped: GmailMessage[] = [];
      for (const message of normalized) {
        if (seen.has(message.source_key)) {
          continue;
        }
        seen.add(message.source_key);
        deduped.push(message);
      }

      allMessages.push(...deduped);
      perAccount.push({
        account_email: account,
        query: accountQuery,
        since_ts: new Date(sinceEpoch * 1000).toISOString(),
        fetched_count: deduped.length,
      });
    } catch (error) {
      perAccount.push({
        account_email: account,
        query: pollQuery,
        since_ts: new Date(Date.now() - overlapMinutes * 60_000).toISOString(),
        fetched_count: 0,
        error: error instanceof Error ? error.message : "unknown polling error",
      });
    }
  }

  const output: PollOutput = {
    command: "poll_inboxes",
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    poll_query: pollQuery,
    overlap_minutes: overlapMinutes,
    max_results: maxResults,
    per_account: perAccount,
    partial_failure: perAccount.some((entry) => Boolean(entry.error)),
    total_messages: allMessages.length,
    messages: allMessages,
  };

  await writeJson(outputPath, output);
  console.log(JSON.stringify(output, null, 2));
}

await main();
