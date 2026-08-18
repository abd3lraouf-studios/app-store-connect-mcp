/**
 * The MCP surface: a handful of tools covering 1,293 operations.
 *
 * One tool per endpoint would cost well over 100k tokens of definitions before
 * the model had done anything, and would go stale every time Apple ships an API
 * version. Parameterised dispatch keeps the definitions small and makes
 * coverage a property of Apple's spec rather than of how much of it someone got
 * around to wrapping.
 *
 * Dispatch is parameterised, deliberately NOT code execution. Handing the model
 * a JavaScript sandbox would be more expressive and would also mean running
 * generated code inside a process holding an App Store Connect signing key.
 * Node's `vm` is not a security boundary — any injected host object leaks the
 * host realm through its own prototype chain — so the expressiveness is not
 * worth what it costs.
 *
 * Reads and writes are separate tools on purpose. Claude Code ignores the
 * standard `destructiveHint` annotation but honours
 * `_meta["anthropic/requiresUserInteraction"]`, and that flag is per-tool. A
 * single dispatcher could not vary it per operation, so `asc_write` carries it
 * and becomes un-bypassable — a stronger guarantee than the in-process gate,
 * which `--no-confirm` can switch off.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { Config } from './config.js';
import { resolveCredentials } from './credentials.js';
import { TokenMinter } from './jwt.js';
import { ApiClient, ApiError, renderPath } from './http.js';
import { SafetyGate, isWrite, RISK_EXPLANATION, type Risk } from './safety.js';
import { loadIndex, searchOperations, describeOperation, findOperation } from './spec.js';
import { STOREKIT_BY_ID, STOREKIT_OPERATIONS, STOREKIT_HOSTS } from './storekit.js';
import { ResponseStore, staticResources, OVERFLOW_SCHEME } from './resources.js';
import { fitToBudget, DEFAULT_MAX_CHARS } from './truncate.js';
import { PROMPTS, renderPrompt } from './prompts.js';

const MAX_PAGES_CAP = 50;

/** Claude Code accepts up to 500k characters for a single tool result. */
const RESULT_SIZE_META = { 'anthropic/maxResultSizeChars': 200_000 };

interface Resolved {
  api: 'connect' | 'storekit';
  id: string;
  method: string;
  pathTemplate: string;
  risk: Risk;
  contentType?: string;
  baseUrl: string;
}

export function createServer(config: Config): Server {
  const creds = resolveCredentials({
    keyRef: config.keyRef,
    issuerId: config.issuerId,
    keyId: config.keyId,
  });
  const minter = new TokenMinter(creds, config.bundleId);
  const client = new ApiClient(minter);
  const gate = new SafetyGate(config.safety);
  const index = loadIndex();
  const store = new ResponseStore();
  const resources = staticResources();

  const server = new Server(
    { name: 'app-store-connect-mcp', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  function resolve(operationId: string): Resolved {
    const sk = STOREKIT_BY_ID.get(operationId);
    if (sk) {
      return {
        api: 'storekit',
        id: sk.id,
        method: sk.method,
        pathTemplate: sk.path,
        risk: sk.risk,
        contentType: sk.contentType,
        baseUrl: STOREKIT_HOSTS[config.storekitEnvironment],
      };
    }
    const op = findOperation(operationId);
    if (!op) {
      throw new Error(
        `Unknown operationId "${operationId}". Use asc_search_endpoints to find the right one.`
      );
    }
    return {
      api: 'connect',
      id: op.id,
      method: op.method,
      pathTemplate: op.path,
      risk: op.risk,
      baseUrl: index.baseUrl,
    };
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  const CALL_PARAMS = {
    path_params: { type: 'object', description: 'Values for {placeholders}, e.g. {"id": "6763390896"}.' },
    query: {
      type: 'object',
      description:
        'Query parameters. Arrays are sent as repeated keys. Filters look like {"filter[bundleId]": "com.x"}; ' +
        'sparse fieldsets like {"fields[apps]": "name,bundleId"}; "limit" caps at 200. ' +
        'Territories are ISO alpha-3 (USA, not US) — the two-letter form returns an empty list, not an error.',
    },
    environment: {
      type: 'string',
      enum: ['Production', 'Sandbox'],
      description: 'StoreKit only; overrides the server default for this call.',
    },
  } as const;

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'asc_status',
        description:
          'Verify credentials and report what this server can reach, including the remaining rate-limit budget. ' +
          'Run this first when anything fails — it distinguishes a bad key from a bad request.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'asc_search_endpoints',
        description:
          `Find operations across the App Store Connect API (${index.operationCount} operations, ` +
          `v${index.apiVersion}) and the App Store Server API / StoreKit 2 (${STOREKIT_OPERATIONS.length}). ` +
          'Search by keyword, method, tag or risk tier; returns operationIds for asc_call and asc_write. ' +
          'Start here rather than guessing a path — some resources are not where the URL pattern implies.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keyword, e.g. "subscription price", "builds", "refund".' },
            api: { type: 'string', enum: ['connect', 'storekit', 'both'], description: 'Default "both".' },
            method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] },
            tag: { type: 'string', description: 'App Store Connect tag, e.g. "Apps", "Builds".' },
            risk: {
              type: 'string',
              enum: ['READ', 'WRITE', 'RELEASE', 'REVENUE', 'INFRASTRUCTURE', 'ACCESS', 'DESTRUCTIVE'],
            },
            limit: { type: 'number', description: 'Default 25, max 200.' },
          },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'asc_describe_endpoint',
        description:
          'Full detail for one operation: every parameter, the request body schema with real field names, ' +
          'and its risk tier. Call this before any write.',
        inputSchema: {
          type: 'object',
          properties: { operationId: { type: 'string' } },
          required: ['operationId'],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'asc_call',
        description:
          'Read from Apple. Handles both APIs, path and query parameters, and pagination. ' +
          'READ operations only — anything that changes data goes through asc_write. ' +
          'A short list may just be one page: if the result says `truncated`, say so rather than treating it as complete.',
        inputSchema: {
          type: 'object',
          properties: {
            operationId: { type: 'string', description: 'From asc_search_endpoints.' },
            ...CALL_PARAMS,
            paginate: { type: 'boolean', description: 'Follow links.next and concatenate.' },
            max_pages: { type: 'number', description: `Default 10, cap ${MAX_PAGES_CAP}.` },
          },
          required: ['operationId'],
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
        _meta: RESULT_SIZE_META,
      },
      {
        name: 'asc_write',
        description:
          'Change something in App Store Connect: create, update or delete. ' +
          'Consequential tiers (REVENUE, DESTRUCTIVE, INFRASTRUCTURE, ACCESS, RELEASE) ask the user to confirm ' +
          'before anything is sent. Use dry_run first when you are unsure what a call will do — it validates and ' +
          'reports the exact request without sending it. Read asc_describe_endpoint first to get the body schema right.',
        inputSchema: {
          type: 'object',
          properties: {
            operationId: { type: 'string', description: 'From asc_search_endpoints.' },
            ...CALL_PARAMS,
            body: { type: 'object', description: 'JSON:API request body. For binary uploads, a base64 string.' },
            dry_run: {
              type: 'boolean',
              description: 'Validate and report the request that would be sent, without sending it.',
            },
            confirm: {
              type: 'string',
              description: 'Confirmation token from a previous gated call. Not needed when the user is prompted directly.',
            },
          },
          required: ['operationId'],
        },
        // Claude Code honours this even under bypassPermissions, which the
        // standard destructiveHint annotation does not achieve.
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        _meta: { ...RESULT_SIZE_META, 'anthropic/requiresUserInteraction': true },
      },
    ],
  }));

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      ...resources.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
      ...store.list().map((entry) => ({
        uri: entry.uri,
        name: `Full result from ${entry.tool}`,
        description: `The complete response (${entry.bytes} bytes) that was too large to return inline.`,
        mimeType: 'application/json',
      })),
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const { uri } = request.params;

    if (uri.startsWith(OVERFLOW_SCHEME)) {
      const entry = store.get(uri);
      if (!entry) {
        throw new Error(`No stored result at ${uri}. Overflow results are kept only for the current session.`);
      }
      return { contents: [{ uri, mimeType: 'application/json', text: entry.text }] };
    }

    const resource = resources.find((r) => r.uri === uri);
    if (!resource) throw new Error(`Unknown resource: ${uri}`);
    return { contents: [{ uri, mimeType: resource.mimeType, text: resource.read() }] };
  });

  // -------------------------------------------------------------------------
  // Prompts
  // -------------------------------------------------------------------------

  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: PROMPTS }));

  server.setRequestHandler(GetPromptRequestSchema, (request) =>
    renderPrompt(request.params.name, request.params.arguments ?? {})
  );

  // -------------------------------------------------------------------------
  // Tool dispatch
  // -------------------------------------------------------------------------

  const text = (value: unknown, isError = false) => ({
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  });

  /**
   * Return a payload, moving it to a resource if it will not fit.
   * A list cut short says so, and says how to narrow the request.
   */
  const sized = (value: unknown, tool: string) => {
    const outcome = fitToBudget(value, DEFAULT_MAX_CHARS);
    if (!outcome.truncated) return text(value);
    const uri = store.store(tool, outcome.overflow as string);
    const withPointer = { ...(JSON.parse(outcome.text) as Record<string, unknown>), fullResult: uri };
    return text(withPointer);
  };

  /**
   * Ask the user directly when the client supports it.
   *
   * Elicitation is the better mechanism because the person, not the model,
   * makes the decision. It is not always available — a non-interactive run has
   * no one to ask — so the hash-bound token remains the fallback rather than
   * being replaced. A client that declares the capability but cannot render
   * the form answers `decline`, which is indistinguishable from a real refusal,
   * so declining always stops the call.
   */
  async function askUser(op: Resolved, path: string, body: unknown): Promise<boolean | undefined> {
    if (!server.getClientCapabilities()?.elicitation) return undefined;
    try {
      const result = await server.elicitInput({
        message:
          `${op.risk}: ${RISK_EXPLANATION[op.risk]}\n\n` +
          `${op.method} ${path}\n` +
          (body ? `\n${JSON.stringify(body, null, 2).slice(0, 1000)}\n` : '') +
          `\nProceed?`,
        requestedSchema: {
          type: 'object',
          properties: {
            confirmed: {
              type: 'boolean',
              title: 'Proceed with this change',
              description: `Confirm this ${op.risk} operation against your App Store Connect account.`,
            },
          },
          required: ['confirmed'],
        },
      });
      return result.action === 'accept' && result.content?.confirmed === true;
    } catch {
      // A client that advertises elicitation but fails to serve it must not
      // become a way past the gate.
      return undefined;
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, any>;

    try {
      switch (name) {
        case 'asc_status': {
          const probe = await client.request({
            baseUrl: index.baseUrl,
            method: 'GET',
            path: '/v1/apps',
            query: { limit: 1, 'fields[apps]': 'bundleId,name' },
            audience: 'connect',
          });
          const apps = (probe.data as any)?.data ?? [];
          return text({
            connected: true,
            keySource: creds.source,
            keyId: creds.keyId,
            issuerId: creds.issuerId,
            bundleId: config.bundleId ?? '(unset — App Store Server API calls will fail)',
            safetyMode: gate.describeMode,
            elicitation: server.getClientCapabilities()?.elicitation
              ? 'supported — writes prompt the user directly'
              : 'unavailable — writes fall back to a confirmation token',
            storekitEnvironment: config.storekitEnvironment,
            rateLimit: client.limiter.state,
            connectApi: { version: index.apiVersion, operations: index.operationCount },
            storeKitApi: {
              operations: STOREKIT_OPERATIONS.length,
              host: STOREKIT_HOSTS[config.storekitEnvironment],
            },
            sampleApp: apps[0]?.attributes ?? null,
          });
        }

        case 'asc_search_endpoints': {
          const scope = args.api ?? 'both';
          const out: Record<string, unknown> = {};

          if (scope !== 'storekit') {
            const { total, results } = searchOperations({
              query: args.query,
              method: args.method,
              tag: args.tag,
              risk: args.risk,
              limit: args.limit,
            });
            out.connect = {
              matched: total,
              showing: results.length,
              operations: results.map((o) => ({
                operationId: o.id,
                method: o.method,
                path: o.path,
                risk: o.risk,
                tool: o.risk === 'READ' ? 'asc_call' : 'asc_write',
                summary: o.summary || undefined,
              })),
            };
          }

          if (scope !== 'connect') {
            const terms = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
            const hits = STOREKIT_OPERATIONS.filter((o) => {
              const haystack = `${o.id} ${o.path} ${o.summary}`.toLowerCase();
              return (
                terms.every((t) => haystack.includes(t)) &&
                (!args.method || o.method === args.method) &&
                (!args.risk || o.risk === args.risk)
              );
            });
            out.storekit = {
              matched: hits.length,
              operations: hits.map((o) => ({
                operationId: o.id,
                method: o.method,
                path: o.path,
                risk: o.risk,
                tool: o.risk === 'READ' ? 'asc_call' : 'asc_write',
                summary: o.summary,
              })),
            };
          }
          return sized(out, 'asc_search_endpoints');
        }

        case 'asc_describe_endpoint': {
          const sk = STOREKIT_BY_ID.get(args.operationId);
          if (sk) {
            return text({
              ...sk,
              api: 'App Store Server API (StoreKit 2)',
              tool: sk.risk === 'READ' ? 'asc_call' : 'asc_write',
              riskMeaning: RISK_EXPLANATION[sk.risk],
              host: STOREKIT_HOSTS[config.storekitEnvironment],
              note: 'Responses are JWS-signed; this server decodes them into *_decoded fields WITHOUT verifying Apple’s signature.',
            });
          }
          const described = describeOperation(args.operationId);
          return sized(
            {
              ...described,
              tool: described.risk === 'READ' ? 'asc_call' : 'asc_write',
              riskMeaning: RISK_EXPLANATION[described.risk as Risk],
            },
            'asc_describe_endpoint'
          );
        }

        case 'asc_call':
        case 'asc_write': {
          const op = resolve(args.operationId);
          const writing = isWrite(op.risk);

          // Keep the split honest in both directions rather than silently
          // doing the other tool's job.
          if (name === 'asc_call' && writing) {
            return text(
              {
                error: `${op.id} is a ${op.risk} operation, not a read. Use asc_write, which asks the user before changing anything.`,
                risk: op.risk,
                riskMeaning: RISK_EXPLANATION[op.risk],
              },
              true
            );
          }
          if (name === 'asc_write' && !writing) {
            return text(
              { error: `${op.id} only reads data. Use asc_call.`, risk: op.risk },
              true
            );
          }

          const path = renderPath(op.pathTemplate, args.path_params ?? {});
          const baseUrl =
            op.api === 'storekit' && args.environment
              ? STOREKIT_HOSTS[args.environment as 'Production' | 'Sandbox']
              : op.baseUrl;

          if (writing && args.dry_run) {
            return text({
              dryRun: true,
              wouldSend: { method: op.method, url: `${baseUrl}${path}`, query: args.query, body: args.body },
              risk: op.risk,
              riskMeaning: RISK_EXPLANATION[op.risk],
              note: 'Nothing was sent to Apple. Remove dry_run to execute.',
            });
          }

          if (writing) {
            const approved = await askUser(op, path, args.body);
            if (approved === false) {
              return text({ blocked: true, message: 'The user declined this change.' }, true);
            }
            if (approved === undefined) {
              // No elicitation available: fall back to the token handshake.
              const blocked = gate.check(
                { operationId: op.id, method: op.method, path, query: args.query, body: args.body },
                op.risk,
                args.confirm
              );
              if (blocked) {
                return text(
                  blocked.token
                    ? { confirmationRequired: true, risk: op.risk, token: blocked.token, message: blocked.reason }
                    : { blocked: true, message: blocked.reason },
                  !blocked.token
                );
              }
            }
          }

          const spec = {
            baseUrl,
            method: op.method,
            path,
            query: args.query,
            body: args.body,
            contentType: op.contentType,
            audience: op.api === 'storekit' ? ('storekit' as const) : ('connect' as const),
          };

          if (args.paginate && op.method === 'GET') {
            const pages = Math.min(args.max_pages ?? 10, MAX_PAGES_CAP);
            const result = await client.requestAll(spec, pages);
            const body = result.data as Record<string, any>;
            if (body.pages >= pages) {
              body.pageCapReached =
                `Stopped at the ${pages}-page cap; more results may exist. Raise max_pages (cap ${MAX_PAGES_CAP}).`;
            }
            return sized(result.data, name);
          }

          const result = await client.request(spec);
          return sized(result.data, name);
        }

        default:
          return text(`Unknown tool: ${name}`, true);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return text(
          {
            error: error.message,
            status: error.status,
            requestId: error.requestId,
            ambiguous: error.ambiguous || undefined,
            detail: error.detail,
            hint:
              error.ambiguous
                ? 'This write was not retried, because Apple may already have applied it. Check the current state before trying again.'
                : error.status === 401
                  ? 'Authentication failed. Run asc_status. Check that the key ID matches the key material and that the key is still active.'
                  : error.status === 403
                    ? 'Authorised, but this API key’s role cannot perform that operation.'
                    : error.status === 404
                      ? 'Not found. Confirm the path parameters — an ID of the wrong resource type returns 404 rather than a validation error. Some resources are also not where the URL pattern implies; see the asc://cookbook resource.'
                      : error.status === 429
                        ? 'Rate limited. asc_status reports the remaining budget; note that it belongs to the key, so other agents or CI jobs share it.'
                        : undefined,
          },
          true
        );
      }
      return text({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  });

  return server;
}

export { isWrite };
