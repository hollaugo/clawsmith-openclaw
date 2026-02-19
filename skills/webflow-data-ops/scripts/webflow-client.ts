export type JsonObject = Record<string, unknown>;

export type DataOpsMode = "site-token" | "read-only";

export type RuntimeEnv = {
  siteId?: string;
  siteToken?: string;
  workspaceToken?: string;
  mode: DataOpsMode;
  reason?: string;
};

export type WebflowRequestError = {
  status: number;
  message: string;
  details?: unknown;
};

const DEFAULT_API_BASE_URL = "https://api.webflow.com/v2";
const DEFAULT_TIMEOUT_MS = 20_000;

function clean(input: string | undefined): string | undefined {
  const value = input?.trim();
  return value ? value : undefined;
}

export function resolveRuntimeEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  const siteToken = clean(env.WEBFLOW_SITE_API_TOKEN);
  const workspaceToken = clean(env.WEBFLOW_WORKSPACE_API_TOKEN);
  const siteId = clean(env.WEBFLOW_SITE_ID);

  if (siteToken) {
    return {
      siteId,
      siteToken,
      workspaceToken,
      mode: "site-token",
    };
  }

  if (workspaceToken) {
    return {
      siteId,
      siteToken,
      workspaceToken,
      mode: "read-only",
      reason:
        "WEBFLOW_SITE_API_TOKEN is required for data endpoint writes. Workspace token-only mode is advisory.",
    };
  }

  return {
    siteId,
    siteToken,
    workspaceToken,
    mode: "read-only",
    reason:
      "No Webflow token found. Set WEBFLOW_SITE_API_TOKEN for data operations, and WEBFLOW_SITE_ID for default site target.",
  };
}

function stringifyQuery(query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function fail(status: number, message: string, details?: unknown): never {
  const error = new Error(message) as Error & { webflow: WebflowRequestError };
  error.webflow = { status, message, details };
  throw error;
}

export class WebflowClient {
  private readonly token: string;

  private readonly apiBaseUrl: string;

  private readonly timeoutMs: number;

  constructor(params: { token: string; apiBaseUrl?: string; timeoutMs?: number }) {
    this.token = params.token;
    this.apiBaseUrl = params.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T extends JsonObject | JsonObject[]>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    options?: {
      body?: JsonObject;
      query?: Record<string, string | number | boolean | undefined>;
    },
  ): Promise<T> {
    const query = options?.query ? stringifyQuery(options.query) : "";
    const url = `${this.apiBaseUrl}${path}${query}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: options?.body ? JSON.stringify(options.body) : undefined,
      });

      const body = await parseResponseBody(response);

      if (!response.ok) {
        const message =
          (body as JsonObject | undefined)?.message ??
          (body as JsonObject | undefined)?.error ??
          `Webflow request failed (${response.status})`;
        fail(response.status, String(message), body);
      }

      return (body as T) ?? ({} as T);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        fail(408, "Webflow request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  listSites() {
    return this.request<JsonObject>("GET", "/sites");
  }

  getSite(siteId: string) {
    return this.request<JsonObject>("GET", `/sites/${siteId}`);
  }

  listPages(siteId: string) {
    return this.request<JsonObject>("GET", `/sites/${siteId}/pages`);
  }

  getPage(siteId: string, pageId: string) {
    return this.request<JsonObject>("GET", `/sites/${siteId}/pages/${pageId}`);
  }

  updatePage(siteId: string, pageId: string, patch: JsonObject) {
    return this.request<JsonObject>("PATCH", `/sites/${siteId}/pages/${pageId}`, { body: patch });
  }

  listComponents(siteId: string) {
    return this.request<JsonObject>("GET", `/sites/${siteId}/components`);
  }

  getComponent(siteId: string, componentId: string) {
    return this.request<JsonObject>("GET", `/sites/${siteId}/components/${componentId}`);
  }

  updateComponent(siteId: string, componentId: string, patch: JsonObject) {
    return this.request<JsonObject>("PATCH", `/sites/${siteId}/components/${componentId}`, {
      body: patch,
    });
  }

  listCollections(siteId: string) {
    return this.request<JsonObject>("GET", `/sites/${siteId}/collections`);
  }

  listCollectionFields(collectionId: string) {
    return this.request<JsonObject>("GET", `/collections/${collectionId}/fields`);
  }

  listCollectionItems(collectionId: string, limit = 100) {
    return this.request<JsonObject>("GET", `/collections/${collectionId}/items`, {
      query: { limit },
    });
  }

  getCollectionItem(collectionId: string, itemId: string) {
    return this.request<JsonObject>("GET", `/collections/${collectionId}/items/${itemId}`);
  }

  updateCollectionItem(collectionId: string, itemId: string, patch: JsonObject) {
    return this.request<JsonObject>("PATCH", `/collections/${collectionId}/items/${itemId}`, {
      body: patch,
    });
  }

  createCollectionItem(collectionId: string, payload: JsonObject) {
    return this.request<JsonObject>("POST", `/collections/${collectionId}/items`, {
      body: payload,
    });
  }
}

export function createDataOpsClientFromEnv(env: NodeJS.ProcessEnv = process.env): {
  env: RuntimeEnv;
  client?: WebflowClient;
} {
  const runtime = resolveRuntimeEnv(env);
  if (!runtime.siteToken) {
    return { env: runtime };
  }
  return {
    env: runtime,
    client: new WebflowClient({ token: runtime.siteToken }),
  };
}

export function extractList(value: unknown): JsonObject[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object");
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const obj = value as JsonObject;
  const candidates = ["items", "pages", "components", "collections", "fields", "sites", "data"];
  for (const key of candidates) {
    const entry = obj[key];
    if (Array.isArray(entry)) {
      return entry.filter((item): item is JsonObject => Boolean(item) && typeof item === "object");
    }
  }
  return [];
}

export function getString(value: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}
