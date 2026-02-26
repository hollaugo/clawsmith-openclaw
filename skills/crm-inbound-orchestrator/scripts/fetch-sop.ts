import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type CliArgs = {
  command?: string;
  flags: Record<string, string | boolean>;
};

type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
};

type SopBlock = {
  id: string;
  type: string;
  text: string;
  depth: number;
  has_children: boolean;
};

type SopSnapshot = {
  status: "ok" | "degraded";
  degraded: boolean;
  source: "notion" | "cache";
  page_id: string;
  fetched_at: string;
  warnings: string[];
  sop: {
    title: string;
    hash: string;
    block_count: number;
    blocks: SopBlock[];
    sections: Array<{ heading: string; items: string[] }>;
  };
};

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const DEFAULT_CACHE_FILE = "/tmp/crm-inbound-sop-cache.json";

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

function extractRichText(block: NotionBlock): string {
  const payload = block[block.type] as Record<string, unknown> | undefined;
  const richText = payload?.rich_text;
  if (!Array.isArray(richText)) {
    return "";
  }

  return richText
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const plain = (entry as Record<string, unknown>).plain_text;
      return typeof plain === "string" ? plain : "";
    })
    .join("")
    .trim();
}

async function notionRequest(
  token: string,
  endpoint: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${NOTION_API_BASE}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  const body = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    const message =
      (body.message && typeof body.message === "string" && body.message) ||
      `Notion request failed (${response.status})`;
    throw new Error(message);
  }

  return body;
}

async function listBlockChildren(token: string, blockId: string): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;

  while (true) {
    const query = cursor
      ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
      : "?page_size=100";
    const body = await notionRequest(token, `/blocks/${blockId}/children${query}`);
    const results = body.results;

    if (Array.isArray(results)) {
      for (const result of results) {
        if (!result || typeof result !== "object") {
          continue;
        }
        const block = result as NotionBlock;
        if (typeof block.id !== "string" || typeof block.type !== "string") {
          continue;
        }
        blocks.push(block);
      }
    }

    const hasMore = body.has_more === true;
    const nextCursor = typeof body.next_cursor === "string" ? body.next_cursor : undefined;
    if (!hasMore || !nextCursor) {
      break;
    }
    cursor = nextCursor;
  }

  return blocks;
}

async function walkBlocks(
  token: string,
  blockId: string,
  depth = 0,
  acc: SopBlock[] = [],
): Promise<SopBlock[]> {
  const children = await listBlockChildren(token, blockId);

  for (const child of children) {
    const text = extractRichText(child);
    acc.push({
      id: child.id,
      type: child.type,
      text,
      depth,
      has_children: child.has_children === true,
    });

    if (child.has_children === true) {
      await walkBlocks(token, child.id, depth + 1, acc);
    }
  }

  return acc;
}

function buildSections(blocks: SopBlock[]): Array<{ heading: string; items: string[] }> {
  const sections: Array<{ heading: string; items: string[] }> = [];
  let current: { heading: string; items: string[] } | undefined;

  for (const block of blocks) {
    if (block.type.startsWith("heading_")) {
      current = { heading: block.text || "Untitled", items: [] };
      sections.push(current);
      continue;
    }

    if (!block.text) {
      continue;
    }

    if (!current) {
      current = { heading: "General", items: [] };
      sections.push(current);
    }

    current.items.push(block.text);
  }

  return sections.map((section) => ({
    heading: section.heading,
    items: Array.from(new Set(section.items)),
  }));
}

function buildHash(blocks: SopBlock[]): string {
  const normalized = blocks.map((block) => ({
    id: block.id,
    type: block.type,
    text: block.text,
    depth: block.depth,
  }));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function writeJson(filePath: string, payload: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readSnapshot(filePath: string): Promise<SopSnapshot | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as SopSnapshot;
    return parsed;
  } catch {
    return undefined;
  }
}

async function fetchSopSnapshot(options: {
  notionToken: string;
  pageId: string;
}): Promise<SopSnapshot> {
  const page = await notionRequest(options.notionToken, `/pages/${options.pageId}`);
  const properties = page.properties as Record<string, unknown> | undefined;
  const titleCandidates = properties ? Object.values(properties) : [];

  let title = "Inbound SOP";
  for (const candidate of titleCandidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const value = candidate as Record<string, unknown>;
    const titleParts = value.title;
    if (!Array.isArray(titleParts)) {
      continue;
    }
    const derived = titleParts
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const plain = (part as Record<string, unknown>).plain_text;
        return typeof plain === "string" ? plain : "";
      })
      .join("")
      .trim();

    if (derived) {
      title = derived;
      break;
    }
  }

  const blocks = await walkBlocks(options.notionToken, options.pageId);
  const hash = buildHash(blocks);

  return {
    status: "ok",
    degraded: false,
    source: "notion",
    page_id: options.pageId,
    fetched_at: new Date().toISOString(),
    warnings: [],
    sop: {
      title,
      hash,
      block_count: blocks.length,
      blocks,
      sections: buildSections(blocks),
    },
  };
}

async function main() {
  const { command, flags } = parseArgs(process.argv);
  if (command !== "fetch_sop") {
    console.error(
      "Usage: bun fetch-sop.ts fetch_sop [--page-id <id>] [--cache-file <path>] [--output <path>]",
    );
    process.exit(1);
  }

  const notionToken = clean(process.env.NOTION_API_KEY);
  if (!notionToken) {
    throw new Error("NOTION_API_KEY is required");
  }

  const pageId =
    clean(asString(flags["page-id"])) ||
    clean(process.env.CRM_SOP_PAGE_ID) ||
    "31288fb313488013924ade7bf704ab6f";
  const cacheFile =
    clean(asString(flags["cache-file"])) ||
    clean(process.env.CRM_SOP_CACHE_FILE) ||
    DEFAULT_CACHE_FILE;
  const output = clean(asString(flags.output)) || cacheFile;

  try {
    const snapshot = await fetchSopSnapshot({ notionToken, pageId });
    await writeJson(cacheFile, snapshot);

    if (output !== cacheFile) {
      await writeJson(output, snapshot);
    }

    console.log(JSON.stringify(snapshot, null, 2));
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown Notion error";
    const cached = await readSnapshot(cacheFile);

    if (!cached) {
      throw new Error(`SOP fetch failed and no cache is available: ${message}`);
    }

    const degraded: SopSnapshot = {
      ...cached,
      status: "degraded",
      degraded: true,
      source: "cache",
      fetched_at: new Date().toISOString(),
      warnings: [
        ...cached.warnings,
        `Notion fetch failed: ${message}`,
        "Using cached SOP snapshot.",
      ],
    };

    if (output) {
      await writeJson(output, degraded);
    }

    console.log(JSON.stringify(degraded, null, 2));
  }
}

await main();
