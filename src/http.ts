/**
 * One request path for both APIs.
 *
 * Differences between App Store Connect and the App Store Server API amount to
 * a base URL, a token audience, and how errors and pagination are shaped — all
 * parameterised here rather than duplicated into two clients.
 */
import { TokenMinter, type Audience, decodeJwsPayload } from './jwt.js';
import { decodeSignedFields } from './storekit.js';

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
  /** Present when the caller asked to follow pagination. */
  pages?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Apple accepts repeated keys for array-valued filters; URLSearchParams handles that. */
function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      // ASC expects comma-joined values for filter/fields params, but the
      // Server API expects the key repeated. Repeating works for both because
      // ASC also accepts repeats; comma-joining does not work for StoreKit.
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

export class ApiClient {
  constructor(private readonly minter: TokenMinter) {}

  async request(spec: RequestSpec, retryOn401 = true): Promise<ApiResult> {
    const url = `${spec.baseUrl}${spec.path}${buildQuery(spec.query)}`;
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

    const res = await fetch(url, { method: spec.method, headers, body: payload });

    const text = await res.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        /* Some endpoints return an empty or non-JSON body; keep the raw text. */
      }
    }

    // A cached token can outlive a key rotation. Retry once with a fresh one
    // before reporting an auth failure the caller cannot act on.
    if (res.status === 401 && retryOn401) {
      this.minter.invalidate();
      return this.request(spec, false);
    }

    if (!res.ok) {
      throw new ApiError(res.status, data, describeError(res.status, data));
    }

    // StoreKit payloads are mostly JWS; decode them so the result is usable.
    if (spec.audience === 'storekit') {
      data = decodeSignedFields(data, decodeJwsPayload);
    }

    return { status: res.status, ok: true, data };
  }

  /**
   * Follow pagination and concatenate results.
   *
   * The two APIs paginate differently — Connect exposes an absolute
   * `links.next` URL, the Server API returns an opaque `revision` /
   * `paginationToken` that must be fed back as a query parameter — so both are
   * handled explicitly rather than guessed at.
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

      // Connect API: absolute next link.
      const next: string | undefined = d?.links?.next;
      if (next) {
        const u = new URL(next);
        current = { ...spec, path: u.pathname, query: Object.fromEntries(u.searchParams) };
        continue;
      }

      // Server API: opaque cursor, only meaningful while hasMore is true.
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
