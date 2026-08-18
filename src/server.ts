/**
 * The MCP surface: four tools covering ~1,293 operations.
 *
 * The alternative — one tool per endpoint — costs well over 100k tokens of
 * tool definitions before the model has done anything, and goes stale every
 * time Apple ships an API version. Parameterised dispatch keeps the definitions
 * to a few hundred tokens and makes coverage a property of the spec rather than
 * of how much of it someone got around to wrapping.
 *
 * Dispatch is parameterised, deliberately NOT code execution. Handing a model a
 * JavaScript sandbox to build these calls in would be more expressive and would
 * also mean running generated code in a process holding an App Store Connect
 * signing key. `vm` is not a security boundary — any injected host object leaks
 * the host realm through its own prototype chain — so the extra expressiveness
 * is not worth what it costs.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { Config } from './config.js';
import { resolveCredentials } from './credentials.js';
import { TokenMinter } from './jwt.js';
import { ApiClient, ApiError, renderPath } from './http.js';
import { SafetyGate, isWrite, RISK_EXPLANATION, type Risk } from './safety.js';
import { loadIndex, searchOperations, describeOperation, findOperation } from './spec.js';
import { STOREKIT_BY_ID, STOREKIT_OPERATIONS, STOREKIT_HOSTS } from './storekit.js';

const MAX_PAGES_CAP = 50;

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

  const server = new Server(
    { name: 'app-store-connect-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
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

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'asc_status',
        description:
          'Verify credentials and report what this server can reach. Run this first when anything fails — it distinguishes a bad key from a bad request.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'asc_search_endpoints',
        description:
          `Find operations across the App Store Connect API (${index.operationCount} operations, ` +
          `v${index.apiVersion}) and the App Store Server API / StoreKit 2 (${STOREKIT_OPERATIONS.length}). ` +
          'Search by keyword, HTTP method, tag or risk tier. Returns operationIds to pass to asc_call. ' +
          'Start here rather than guessing a path.',
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
          'Full detail for one operation: every parameter, the request body schema with real field names, and the risk tier. Call this before any write.',
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
          'Execute an operation against Apple. Handles both APIs, path parameters, query parameters, JSON bodies and pagination. ' +
          'Writes in the REVENUE, DESTRUCTIVE, INFRASTRUCTURE, ACCESS and RELEASE tiers return a confirmation token instead of executing — ' +
          'relay what will change to the user, get their agreement, then repeat the call with `confirm`.',
        inputSchema: {
          type: 'object',
          properties: {
            operationId: { type: 'string', description: 'From asc_search_endpoints.' },
            path_params: { type: 'object', description: 'Values for {placeholders}, e.g. {"id": "6763390896"}.' },
            query: {
              type: 'object',
              description:
                'Query parameters. Arrays are sent as repeated keys. ASC filters look like {"filter[bundleId]": "com.x"}; ' +
                'sparse fieldsets like {"fields[apps]": "name,bundleId"}; "limit" caps at 200.',
            },
            body: { type: 'object', description: 'JSON:API request body for POST/PATCH/PUT. For image uploads, a base64 string.' },
            paginate: { type: 'boolean', description: 'Follow pagination and concatenate. GET only.' },
            max_pages: { type: 'number', description: `Default 10, cap ${MAX_PAGES_CAP}.` },
            confirm: { type: 'string', description: 'Confirmation token from a previous gated call.' },
            environment: {
              type: 'string',
              enum: ['Production', 'Sandbox'],
              description: 'StoreKit only; overrides the server default for this call.',
            },
          },
          required: ['operationId'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, any>;

    const text = (value: unknown, isError = false) => ({
      content: [
        { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
      ...(isError ? { isError: true } : {}),
    });

    try {
      switch (name) {
        case 'asc_status': {
          // One cheap authenticated read proves the whole chain: key material,
          // key id, issuer id, clock skew, and network reachability.
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
            storekitEnvironment: config.storekitEnvironment,
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
          const out: any = {};

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
                summary: o.summary || undefined,
              })),
            };
          }

          if (scope !== 'connect') {
            // Term-by-term, matching the Connect-side search: a phrase like
            // "subscription status" appears in no single StoreKit identifier.
            const terms = (args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
            const hits = STOREKIT_OPERATIONS.filter((o) => {
              const haystack = `${o.id} ${o.path} ${o.summary}`.toLowerCase();
              return (
                terms.every((t: string) => haystack.includes(t)) &&
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
                summary: o.summary,
              })),
            };
          }
          return text(out);
        }

        case 'asc_describe_endpoint': {
          const sk = STOREKIT_BY_ID.get(args.operationId);
          if (sk) {
            return text({
              ...sk,
              api: 'App Store Server API (StoreKit 2)',
              riskMeaning: RISK_EXPLANATION[sk.risk],
              host: STOREKIT_HOSTS[config.storekitEnvironment],
              note: 'Responses are JWS-signed; this server decodes them into *_decoded fields WITHOUT verifying Apple’s signature.',
            });
          }
          const described = describeOperation(args.operationId);
          return text({ ...described, riskMeaning: RISK_EXPLANATION[described.risk as Risk] });
        }

        case 'asc_call': {
          const op = resolve(args.operationId);
          const path = renderPath(op.pathTemplate, args.path_params ?? {});

          const baseUrl =
            op.api === 'storekit' && args.environment
              ? STOREKIT_HOSTS[args.environment as 'Production' | 'Sandbox']
              : op.baseUrl;

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
            const body = result.data as any;
            // Say so when the cap truncated the walk, rather than letting a
            // partial result read as the complete set.
            if (body.pages >= pages) {
              body.truncated = `Stopped at the ${pages}-page cap; more results may exist. Raise max_pages (cap ${MAX_PAGES_CAP}).`;
            }
            return text(result.data);
          }

          const result = await client.request(spec);
          return text(result.data);
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
            detail: error.detail,
            hint:
              error.status === 401
                ? 'Authentication failed. Run asc_status. Check that the key ID matches the key material and that the key is still active in App Store Connect.'
                : error.status === 403
                  ? 'Authorised, but this API key’s role cannot perform that operation.'
                  : error.status === 404
                    ? 'Not found. Confirm the path parameters — an ID from the wrong resource type returns 404 rather than a validation error.'
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
