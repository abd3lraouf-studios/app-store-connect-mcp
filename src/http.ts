/**
 * One request path for both APIs.
 *
 * Differences between App Store Connect and the App Store Server API amount to
 * a base URL, a token audience, and how errors and pagination are shaped — all
 * parameterised here rather than duplicated into two clients.
 */
import { TokenMinter, type Audience, decodeJwsPayload } from './jwt.js';
import { decodeSignedFields } from './storekit.js';
import { RateLimiter } from './ratelimit.js';
import { shapeResponse } from './shape.js';

/** Only these hosts may ever receive a bearer token. */
const ALLOWED_HOSTS = new Set([
  'api.appstoreconnect.apple.com',
  'api.storekit.apple.com',
  'api.storekit-sandbox.apple.com',
]);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;

export interface RequestSpec {
  baseUrl: string;
  method: string;
  /** Path with {placeholders} already substituted. */
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  contentType?: string;
  audience: Audience;
}

export interface ApiResult {
  status: number;
  ok: boolean;
  data: unknown;
  /** Apple's request id — quote this when contacting Apple support. */
  requestId?: string;
  /** Present when the caller asked to follow pagination. */
  pages?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
    message: string,
    readonly requestId?: string,
    /** True when we cannot tell whether Apple applied the change. */
    readonly ambiguous = false
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Reject any URL that is not one of Apple's own API hosts.
 *
 * This guards the pagination cursor in particular: `links.next` is a
 * server-supplied absolute URL, and following one blindly would walk a live
 * bearer token to whatever host it names. An allowlist of three exact hostnames
 * avoids hand-rolled IP parsing, which the MCP security guidance warns against
 * because octal, hex and IPv4-mapped-IPv6 forms defeat naive validators.
 *
 * `ASC_BASE_URL` widens the allowlist to its own host so tests can point the
 * client at a local fixture server without disabling the check.
 */
export function assertAllowedUrl(url: URL): void {
  const override = process.env.ASC_BASE_URL;
  if (override) {
    try {
      if (url.host === new URL(override).host) return;
    } catch {
      /* A malformed override must not widen the allowlist. */
    }
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Refusing a non-HTTPS request to ${url.host}.`);
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing to send credentials to ${url.hostname}. Only Apple's API hosts are permitted.`
    );
  }
}

/** Apple accepts repeated keys for array-valued filters; URLSearchParams handles that. */
function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      // The Server API requires the key repeated; ASC accepts repeats as well
      // as comma-joining, so repeating is the form that works for both.
      for (const v of value) params.append(key, String(v));
    } else {
      params.append(key, String(value));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Render Apple's error payloads into something a model can act on.
 *
 * The two APIs disagree: Connect returns JSON:API `{errors:[{status,code,title,detail}]}`,
 * the Server API returns `{errorCode, errorMessage}`. Collapsing both into one
 * readable line avoids the caller having to know which API it just used.
 */
function describeError(status: number, data: unknown): string {
  if (data && typeof data === 'object') {
    const d = data as Record<string, any>;
    if (Array.isArray(d.errors)) {
      return d.errors
        .map((e: any) => `${e.status ?? status} ${e.code ?? ''}: ${e.title ?? ''}${e.detail ? ` — ${e.detail}` : ''}`)
        .join('; ');
    }
    if (d.errorCode || d.errorMessage) {
      return `${status} ${d.errorCode ?? ''}: ${d.errorMessage ?? ''}`;
    }
  }
  return `HTTP ${status}`;
}

const RETRYABLE_FOR_READS = new Set([408, 429, 500, 502, 503, 504]);

export class ApiClient {
  readonly limiter: RateLimiter;

  constructor(
    private readonly minter: TokenMinter,
    private readonly options: { timeoutMs?: number; shape?: boolean } = {},
    limiter?: RateLimiter
  ) {
    this.limiter = limiter ?? new RateLimiter();
  }

  async request(spec: RequestSpec): Promise<ApiResult> {
    const url = new URL(`${spec.baseUrl}${spec.path}${buildQuery(spec.query)}`);
    assertAllowedUrl(url);

    const isWrite = spec.method !== 'GET';
    let refreshedToken = false;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      await this.limiter.acquire();

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.minter.mint(spec.audience)}`,
        Accept: 'application/json',
      };

      let payload: string | Buffer | undefined;
      if (spec.body !== undefined && spec.body !== null) {
        if (spec.contentType && spec.contentType !== 'application/json') {
          headers['Content-Type'] = spec.contentType;
          payload = Buffer.from(String(spec.body), 'base64');
        } else {
          headers['Content-Type'] = 'application/json';
          payload = JSON.stringify(spec.body);
        }
      }

      let res: Response;
      try {
        res = await fetch(url, {
          method: spec.method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        // A write that times out may still have been applied. Never resend it:
        // a duplicated POST is worse than a reported failure.
        if (isWrite) {
          throw new ApiError(
            0,
            { cause: String(error) },
            timedOut
              ? `Request timed out after ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms. ` +
                  'Apple may or may not have applied this change — check before retrying.'
              : `Network error: ${String(error)}`,
            undefined,
            true
          );
        }
        if (attempt <= MAX_RETRIES) {
          await this.backoff(attempt);
          continue;
        }
        throw new ApiError(0, { cause: String(error) }, `Network error after ${attempt} attempts: ${String(error)}`);
      }

      this.limiter.observeHeader(res.headers.get('x-rate-limit'));
      const requestId = res.headers.get('x-request-id') ?? undefined;

      const text = await res.text();
      let data: unknown = text;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          /* Some endpoints return an empty or non-JSON body; keep the raw text. */
        }
      }

      // A cached token can outlive a key rotation. Refresh once before
      // reporting an auth failure the caller cannot act on.
      if (res.status === 401 && !refreshedToken) {
        refreshedToken = true;
        this.minter.invalidate();
        continue;
      }

      if (!res.ok) {
        // Writes retry only on 429: Apple rejected the request before
        // processing it, so resending cannot duplicate an effect. Every other
        // failure mode is ambiguous for a write.
        const retryable = isWrite ? res.status === 429 : RETRYABLE_FOR_READS.has(res.status);
        if (retryable && attempt <= MAX_RETRIES) {
          await this.backoff(attempt, res.headers.get('retry-after'));
          continue;
        }
        throw new ApiError(res.status, data, describeError(res.status, data), requestId);
      }

      if (spec.audience === 'storekit') {
        data = decodeSignedFields(data, decodeJwsPayload);
      } else {
        data = shapeResponse(data, this.options.shape !== false);
      }

      return { status: res.status, ok: true, data, requestId };
    }
  }

  private async backoff(attempt: number, retryAfter?: string | null): Promise<void> {
    const headerMs = retryAfter ? Number(retryAfter) * 1000 : NaN;
    const ms = Number.isFinite(headerMs) && headerMs > 0 ? headerMs : Math.min(8000, 2 ** attempt * 250);
    await new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Follow pagination and concatenate results.
   *
   * The two APIs paginate differently — Connect exposes an absolute
   * `links.next` URL, the Server API returns an opaque `revision` /
   * `paginationToken` fed back as a query parameter — so both are handled
   * explicitly rather than guessed at.
   */
  async requestAll(spec: RequestSpec, maxPages: number): Promise<ApiResult> {
    const collected: unknown[] = [];
    let pages = 0;
    let current: RequestSpec | undefined = spec;
    let last: ApiResult | undefined;

    while (current && pages < maxPages) {
      const result: ApiResult = await this.request(current);
      last = result;
      pages += 1;

      const d = result.data as Record<string, any>;
      if (Array.isArray(d?.data)) collected.push(...d.data);
      else if (Array.isArray(d?.signedTransactions_decoded)) collected.push(...d.signedTransactions_decoded);
      else collected.push(d);

      const next: string | undefined = d?.links?.next;
      if (next) {
        const u = new URL(next);
        assertAllowedUrl(u); // A cursor is server-supplied input, not a trusted URL.
        current = { ...spec, path: u.pathname, query: Object.fromEntries(u.searchParams) };
        continue;
      }

      if (d?.hasMore && (d?.revision || d?.paginationToken)) {
        current = {
          ...spec,
          query: {
            ...spec.query,
            ...(d.revision ? { revision: d.revision } : {}),
            ...(d.paginationToken ? { paginationToken: d.paginationToken } : {}),
          },
        };
        continue;
      }

      current = undefined;
    }

    return {
      status: last?.status ?? 200,
      ok: true,
      pages,
      requestId: last?.requestId,
      data: { count: collected.length, pages, items: collected },
    };
  }
}

/** Substitute {placeholders}, and refuse to send a request with any left over. */
export function renderPath(template: string, params: Record<string, unknown> = {}): string {
  const missing: string[] = [];
  const rendered = template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined || v === null || v === '') {
      missing.push(name);
      return `{${name}}`;
    }
    return encodeURIComponent(String(v));
  });
  if (missing.length) {
    throw new Error(`Missing required path parameter(s): ${missing.join(', ')} for ${template}`);
  }
  return rendered;
}
