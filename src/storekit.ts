/**
 * App Store Server API (StoreKit 2) operation catalogue.
 *
 * Apple does not publish an OpenAPI document for this API the way it does for
 * App Store Connect, so this table is transcribed from Apple's own client,
 * `apple/app-store-server-library-node`, which is the authoritative
 * description of the wire format. Two details there contradict what you would
 * guess from the documentation, and both are preserved deliberately:
 *
 *   - The renewal-date-extension status path orders its segments
 *     {productId}/{requestIdentifier}, not the reverse.
 *   - The hosts are api.storekit.apple.com / api.storekit-sandbox.apple.com.
 *     The older api.storekit.itunes.apple.com names no longer serve this API.
 *
 * Keeping the catalogue declarative lets the same dispatcher, safety gate and
 * pagination logic serve both APIs — the only real difference between them is
 * the token audience and the base URL.
 */
import type { Risk } from './safety.js';

export type StoreKitEnvironment = 'Production' | 'Sandbox';

export const STOREKIT_HOSTS: Record<StoreKitEnvironment, string> = {
  Production: 'https://api.storekit.apple.com',
  Sandbox: 'https://api.storekit-sandbox.apple.com',
};

export interface StoreKitOperation {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  summary: string;
  pathParams: string[];
  queryParams: string[];
  /** True when the operation sends a JSON request body. */
  body: boolean;
  /** Non-JSON payload, e.g. a PNG upload. */
  contentType?: string;
  risk: Risk;
}

export const STOREKIT_OPERATIONS: StoreKitOperation[] = [
  // ---- Transactions ------------------------------------------------------
  {
    id: 'storekit_getTransactionInfo',
    method: 'GET',
    path: '/inApps/v1/transactions/{transactionId}',
    summary: 'Get signed transaction info for a single transaction.',
    pathParams: ['transactionId'],
    queryParams: [],
    body: false,
    risk: 'READ',
  },
  {
    id: 'storekit_getTransactionHistory',
    method: 'GET',
    path: '/inApps/{version}/history/{transactionId}',
    summary:
      "Get a customer's transaction history. {version} is v1 or v2; v2 is preferred for new work. Paginated by `revision`.",
    pathParams: ['version', 'transactionId'],
    queryParams: [
      'revision',
      'startDate',
      'endDate',
      'productId',
      'productType',
      'sort',
      'subscriptionGroupIdentifier',
      'inAppOwnershipType',
      'revoked',
    ],
    body: false,
    risk: 'READ',
  },
  {
    id: 'storekit_getAppTransactionInfo',
    method: 'GET',
    path: '/inApps/v1/transactions/appTransactions/{transactionId}',
    summary: 'Get the signed app transaction (the app-purchase receipt) for a transaction.',
    pathParams: ['transactionId'],
    queryParams: [],
    body: false,
    risk: 'READ',
  },
  {
    id: 'storekit_lookUpOrderId',
    method: 'GET',
    path: '/inApps/v1/lookup/{orderId}',
    summary: "Look up a customer's order ID to verify a purchase.",
    pathParams: ['orderId'],
    queryParams: [],
    body: false,
    risk: 'READ',
  },
  {
    id: 'storekit_finishTransaction',
    method: 'POST',
    path: '/inApps/v1/transactions/{transactionId}/finish',
    summary: 'Mark a transaction as finished server-side.',
    pathParams: ['transactionId'],
    queryParams: [],
    body: false,
    risk: 'WRITE',
  },
  {
    id: 'storekit_setAppAccountToken',
    method: 'PUT',
    path: '/inApps/v1/transactions/{originalTransactionId}/appAccountToken',
    summary: 'Set the app account token associated with a purchase.',
    pathParams: ['originalTransactionId'],
    queryParams: [],
    body: true,
    risk: 'WRITE',
  },
  {
    id: 'storekit_sendConsumptionInformation',
    method: 'PUT',
    path: '/inApps/v2/transactions/consumption/{transactionId}',
    summary:
      'Send consumption information for a refund request (v2, current). Apple requires this within 12 hours of a CONSUMPTION_REQUEST notification.',
    pathParams: ['transactionId'],
    queryParams: [],
    body: true,
    risk: 'WRITE',
  },
  {
    id: 'storekit_sendConsumptionInformationV1',
    method: 'PUT',
    path: '/inApps/v1/transactions/consumption/{transactionId}',
    summary: 'Send consumption information (v1, legacy). Prefer the v2 operation.',
    pathParams: ['transactionId'],
    queryParams: [],
    body: true,
    risk: 'WRITE',
  },

  // ---- Subscriptions -----------------------------------------------------
  {
    id: 'storekit_getAllSubscriptionStatuses',
    method: 'GET',
    path: '/inApps/v1/subscriptions/{transactionId}',
    summary:
      "Get the status of every subscription in the customer's group. `status` may repeat to filter.",
    pathParams: ['transactionId'],
    queryParams: ['status'],
    body: false,
    risk: 'READ',
  },
  {
    id: 'storekit_extendSubscriptionRenewalDate',
    method: 'PUT',
    path: '/inApps/v1/subscriptions/extend/{originalTransactionId}',
    summary: "Extend one subscriber's renewal date. Grants paid time — revenue-affecting.",
    pathParams: ['originalTransactionId'],
    queryParams: [],
    body: true,
    risk: 'REVENUE',
  },
  {
    id: 'storekit_extendRenewalDateForAllActiveSubscribers',
    method: 'POST',
    path: '/inApps/v1/subscriptions/extend/mass',
    summary:
      'Extend the renewal date for ALL active subscribers of a product. Applies to every active subscriber at once and cannot be undone.',
    pathParams: [],
    queryParams: [],
    body: true,
    risk: 'REVENUE',
  },
  {
    id: 'storekit_getStatusOfSubscriptionRenewalDateExtensions',
    method: 'GET',
    path: '/inApps/v1/subscriptions/extend/mass/{productId}/{requestIdentifier}',
    summary:
      'Check the progress of a mass renewal-date extension. Note the segment order: productId precedes requestIdentifier.',
    pathParams: ['productId', 'requestIdentifier'],
    queryParams: [],
    body: false,
    risk: 'READ',
  },

  // ---- Refunds -----------------------------------------------------------
  {
    id: 'storekit_getRefundHistory',
    method: 'GET',
    path: '/inApps/v2/refund/lookup/{transactionId}',
    summary: 'Get the refund history for a customer. Paginated by `revision`.',
    pathParams: ['transactionId'],
    queryParams: ['revision'],
    body: false,
    risk: 'READ',
  },

  // ---- Server notifications ---------------------------------------------
  {
    id: 'storekit_requestTestNotification',
    method: 'POST',
    path: '/inApps/v1/notifications/test',
    summary: 'Ask Apple to send a test server notification to your endpoint.',
    pathParams: [],
    queryParams: [],
    body: false,
    risk: 'WRITE',
  },
  {
    id: 'storekit_getTestNotificationStatus',
    method: 'GET',
    path: '/inApps/v1/notifications/test/{testNotificationToken}',
    summary: 'Check the delivery result of a test notification.',
    pathParams: ['testNotificationToken'],
    queryParams: [],
    body: false,
    risk: 'READ',
  },
  {
    id: 'storekit_getNotificationHistory',
    method: 'POST',
    path: '/inApps/v1/notifications/history',
    summary:
      'Get notification delivery history. A POST that reads: the filter travels in the body, and `paginationToken` in the query.',
    pathParams: [],
    queryParams: ['paginationToken'],
    body: true,
    risk: 'READ',
  },

  // ---- In-app messaging --------------------------------------------------
  {
    id: 'storekit_getImageList',
    method: 'GET',
    path: '/inApps/v1/messaging/image/list',
    summary: 'List uploaded messaging images.',
    pathParams: [],
    queryParams: [],
    body: false,
    risk: 'READ',
  },
  {
    id: 'storekit_uploadImage',
    method: 'PUT',
    path: '/inApps/v1/messaging/image/{imageIdentifier}',
    summary: 'Upload a messaging image. Body is raw PNG, supplied as a base64 string or file path.',
    pathParams: ['imageIdentifier'],
    queryParams: ['imageSize'],
    body: true,
    contentType: 'image/png',
    risk: 'WRITE',
  },
  {
    id: 'storekit_deleteImage',
    method: 'DELETE',
    path: '/inApps/v1/messaging/image/{imageIdentifier}',
    summary: 'Delete a messaging image.',
    pathParams: ['imageIdentifier'],
    queryParams: [],
    body: false,
    risk: 'DESTRUCTIVE',
  },
  {
    id: 'storekit_getMessageList',
    method: 'GET',
    path: '/inApps/v1/messaging/message/list',
    summary: 'List uploaded messages.',
    pathParams: [],
    queryParams: [],
    body: false,
    risk: 'READ',
  },
  {
    id: 'storekit_uploadMessage',
    method: 'PUT',
    path: '/inApps/v1/messaging/message/{messageIdentifier}',
    summary: 'Create or replace a message.',
    pathParams: ['messageIdentifier'],
    queryParams: [],
    body: true,
    risk: 'WRITE',
  },
  {
    id: 'storekit_deleteMessage',
    method: 'DELETE',
    path: '/inApps/v1/messaging/message/{messageIdentifier}',
    summary: 'Delete a message.',
    pathParams: ['messageIdentifier'],
    queryParams: [],
    body: false,
    risk: 'DESTRUCTIVE',
  },
  {
    id: 'storekit_getDefaultMessage',
    method: 'GET',
    path: '/inApps/v1/messaging/default/{productId}/{locale}',
    summary: 'Get the default message configured for a product and locale.',
    pathParams: ['productId', 'locale'],
    queryParams: [],
    body: false,
    risk: 'READ',
  },
  {
    id: 'storekit_configureDefaultMessage',
    method: 'PUT',
    path: '/inApps/v1/messaging/default/{productId}/{locale}',
    summary: 'Set the default message for a product and locale. Customer-visible.',
    pathParams: ['productId', 'locale'],
    queryParams: [],
    body: true,
    risk: 'WRITE',
  },
  {
    id: 'storekit_deleteDefaultMessage',
    method: 'DELETE',
    path: '/inApps/v1/messaging/default/{productId}/{locale}',
    summary: 'Remove the default message for a product and locale.',
    pathParams: ['productId', 'locale'],
    queryParams: [],
    body: false,
    risk: 'DESTRUCTIVE',
  },
  {
    id: 'storekit_getRealtimeURL',
    method: 'GET',
    path: '/inApps/v1/messaging/realtime/url',
    summary: 'Get the configured realtime messaging URL.',
    pathParams: [],
    queryParams: [],
    body: false,
    risk: 'READ',
  },
  {
    id: 'storekit_configureRealtimeURL',
    method: 'PUT',
    path: '/inApps/v1/messaging/realtime/url',
    summary: 'Set the realtime messaging URL. Changes where Apple calls your service.',
    pathParams: [],
    queryParams: [],
    body: true,
    risk: 'INFRASTRUCTURE',
  },
  {
    id: 'storekit_deleteRealtimeURL',
    method: 'DELETE',
    path: '/inApps/v1/messaging/realtime/url',
    summary: 'Remove the realtime messaging URL.',
    pathParams: [],
    queryParams: [],
    body: false,
    risk: 'DESTRUCTIVE',
  },
  {
    id: 'storekit_initiatePerformanceTest',
    method: 'POST',
    path: '/inApps/v1/messaging/performanceTest',
    summary: 'Start a messaging performance test.',
    pathParams: [],
    queryParams: [],
    body: true,
    risk: 'WRITE',
  },
  {
    id: 'storekit_getPerformanceTestResults',
    method: 'GET',
    path: '/inApps/v1/messaging/performanceTest/result/{requestId}',
    summary: 'Get the results of a messaging performance test.',
    pathParams: ['requestId'],
    queryParams: [],
    body: false,
    risk: 'READ',
  },
];

export const STOREKIT_BY_ID = new Map(STOREKIT_OPERATIONS.map((o) => [o.id, o]));

/**
 * Recursively decode Apple's JWS-wrapped fields in a response.
 *
 * Every StoreKit payload of consequence arrives as a compact JWS in a field
 * named `signed*` (`signedTransactionInfo`, `signedRenewalInfo`,
 * `signedPayload`, `signedTransactions[]`, …). Returning those to a model as
 * opaque base64 makes the response useless, so they are decoded in place and
 * the original is preserved alongside.
 *
 * These are decoded, NOT verified — verifying the chain requires Apple's root
 * certificates. Everything decoded here is reported as unverified; do not
 * treat it as proof of purchase without checking the signature.
 */
export function decodeSignedFields(value: unknown, decode: (jws: string) => unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => decodeSignedFields(v, decode));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('signed') && typeof v === 'string' && v.split('.').length === 3) {
      out[key] = v;
      out[`${key}_decoded`] = decode(v);
    } else if (
      key.startsWith('signed') &&
      Array.isArray(v) &&
      v.every((x) => typeof x === 'string')
    ) {
      out[key] = v;
      out[`${key}_decoded`] = (v).map(decode);
    } else {
      out[key] = decodeSignedFields(v, decode);
    }
  }
  return out;
}
