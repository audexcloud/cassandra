/**
 * Shared HTTP helper for connectors. Adds a sane timeout, a single retry on
 * transient failures (network errors, 429, 5xx), a stable user-agent, and
 * JSON/text decoding. Connectors should never call `fetch()` directly so we
 * have one place to enforce upstream etiquette.
 */

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_BACKOFF_MS = 600;
const USER_AGENT = "Cassandra-OpenClaw/1.0 (cassandra; +https://replit.com)";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function httpFetch(url: string, opts: HttpOptions): Promise<Response> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = (opts.retries ?? DEFAULT_RETRIES) + 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json, text/plain, */*",
          ...(opts.headers ?? {}),
        },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const transient = res.status === 429 || res.status >= 500;
        const snippet = await res
          .clone()
          .text()
          .then((t) => t.slice(0, 200))
          .catch(() => "");
        const err = new HttpError(
          res.status,
          `HTTP ${res.status} from ${url}: ${snippet}`,
        );
        if (transient && attempt < maxAttempts) {
          lastErr = err;
          await sleep(DEFAULT_BACKOFF_MS * attempt);
          continue;
        }
        throw err;
      }
      return res;
    } catch (err) {
      const transient =
        (err instanceof Error &&
          (err.name === "AbortError" || err.name === "TypeError")) ||
        (err instanceof HttpError && err.transient);
      if (transient && attempt < maxAttempts) {
        lastErr = err;
        await sleep(DEFAULT_BACKOFF_MS * attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error(`httpFetch failed for ${url}`);
}

export async function httpJson<T = unknown>(
  url: string,
  opts: HttpOptions = {},
): Promise<T> {
  const res = await httpFetch(url, opts);
  return (await res.json()) as T;
}

export async function httpText(
  url: string,
  opts: HttpOptions = {},
): Promise<string> {
  const res = await httpFetch(url, opts);
  return res.text();
}
