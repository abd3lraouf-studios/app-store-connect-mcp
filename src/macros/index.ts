/**
 * The composite tools, and the bar they had to clear.
 *
 * A macro is justified only when the raw API cannot express the task in one
 * call: a multi-hop chain where the intermediate results are of no interest, a
 * sequence spanning two hosts, or a payload the caller would otherwise have to
 * decode. A tool that merely saves one request is a maintenance liability —
 * it has to be kept in step with Apple forever and buys nothing `asc_call`
 * does not already do.
 *
 * Five cleared it. Everything else was left out.
 */
import type { MacroContext } from './support.js';
import type { Risk } from '../safety.js';
import { pricingGet, planPriceChange } from './pricing.js';
import { preflightVersion } from './preflight.js';
import { uploadScreenshot, listingScreenshots } from './screenshot.js';
import { analyticsReport } from './analytics.js';

export { type MacroContext } from './support.js';

export interface MacroDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** READ macros execute immediately; anything else goes through the gate. */
  risk: Risk;
  /** A one-line summary of what a write will do, shown in the confirmation. */
  summarise?: (args: Record<string, any>) => string;
}

const APP_ARG = {
  app: { type: 'string', description: 'Bundle ID, store name, or numeric Apple ID.' },
} as const;

export const MACROS: MacroDefinition[] = [
  {
    name: 'asc_pricing_get',
    description:
      'Read subscription pricing across every territory for an app, with the currency resolved and ' +
      'territories grouped by price so outliers stand out. Collapses a four-hop walk and ~175 lookups ' +
      'into a handful of requests. The currency lives on the territory, not the price row, which is why ' +
      'reading prices by hand tends to produce ambiguous numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        ...APP_ARG,
        subscription: { type: 'string', description: 'Product ID, name or id. Omit for all of them.' },
        territory: { type: 'string', description: 'ISO alpha-3, e.g. USA. Omit for every territory.' },
      },
      required: ['app'],
    },
    risk: 'READ',
  },
  {
    name: 'asc_pricing_set',
    description:
      'Change a subscription price. `preserve_current_price` is required and has no default: true keeps ' +
      'existing subscribers on what they pay now, false moves them at their next renewal. Apple defaults ' +
      'it to false, so leaving it implicit silently re-prices your existing base. Find a price point id ' +
      'with asc_call subscriptions_pricePoints_getToManyRelated.',
    inputSchema: {
      type: 'object',
      properties: {
        ...APP_ARG,
        subscription: { type: 'string', description: 'Product ID, name or id.' },
        price_point_id: { type: 'string', description: 'From the subscription’s price points.' },
        preserve_current_price: {
          type: 'boolean',
          description:
            'REQUIRED. true = existing subscribers keep their price. false = they are moved to the new one.',
        },
        territory: { type: 'string', description: 'ISO alpha-3. Omit to apply to the price point’s own territory.' },
        start_date: { type: 'string', description: 'YYYY-MM-DD. Omit to apply as soon as Apple allows.' },
      },
      required: ['app', 'subscription', 'price_point_id', 'preserve_current_price'],
    },
    risk: 'REVENUE',
    summarise: (a) =>
      `Set a new price for ${a.subscription} on ${a.app}` +
      (a.territory ? ` in ${a.territory}` : '') +
      (a.preserve_current_price
        ? '. Existing subscribers keep their current price.'
        : '. Existing subscribers WILL be moved to the new price.'),
  },
  {
    name: 'asc_preflight_version',
    description:
      'Answer "can this version actually be submitted?" across build state, export compliance, every ' +
      'localisation, screenshots, review contact details and any open submission. Returns GO or NO-GO ' +
      'with each gap naming the operation that fixes it. Catches the states that stall a release without ' +
      'explaining themselves — a build still PROCESSING, or an unanswered export-compliance question that ' +
      'parks the version at WAITING_FOR_EXPORT_COMPLIANCE.',
    inputSchema: {
      type: 'object',
      properties: { ...APP_ARG, version: { type: 'string', description: 'Version string. Omit for the newest.' } },
      required: ['app'],
    },
    risk: 'READ',
  },
  {
    name: 'asc_listing_screenshots',
    description:
      'List the screenshot sets and screenshots on a version, with each asset’s delivery state. Uses ' +
      'included resources to turn what is otherwise a request per locale per set into a handful.',
    inputSchema: {
      type: 'object',
      properties: {
        ...APP_ARG,
        version: { type: 'string', description: 'Version string. Omit for the newest.' },
        locale: { type: 'string', description: 'e.g. en-US. Omit to inspect the primary locale only.' },
      },
      required: ['app'],
    },
    risk: 'READ',
  },
  {
    name: 'asc_upload_screenshot',
    description:
      'Upload a screenshot image, performing Apple’s full reserve → upload → commit sequence: reserve a ' +
      'slot, PUT each byte range to Apple’s asset host with the headers Apple supplies, then commit with ' +
      'an MD5 checksum. The raw API cannot do this in one call, and a wrong checksum or offset does not ' +
      'error — it leaves the asset stuck, which looks like nothing happened.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot_set_id: { type: 'string', description: 'From asc_listing_screenshots.' },
        file_path: { type: 'string', description: 'Absolute path to the image on this machine.' },
        file_name: { type: 'string', description: 'Name to store it under. Defaults to the file’s own name.' },
      },
      required: ['screenshot_set_id', 'file_path'],
    },
    risk: 'RELEASE',
    summarise: (a) => `Upload ${a.file_path} into screenshot set ${a.screenshot_set_id}. This is customer-visible.`,
  },
  {
    name: 'asc_analytics_report',
    description:
      'Fetch an analytics report as rows. Walks request → report → instance → every segment, downloads ' +
      'the signed URLs, gunzips the TSV and returns parsed rows. Reading only the first segment — the ' +
      'obvious mistake — yields a plausible subset with nothing marking it partial. Call without ' +
      'report_name to list what exists. Never creates a report request: accessType ONGOING is a standing ' +
      'commitment on the account, not a query.',
    inputSchema: {
      type: 'object',
      properties: {
        ...APP_ARG,
        report_name: { type: 'string', description: 'Omit to list the available reports.' },
        granularity: { type: 'string', enum: ['DAILY', 'WEEKLY', 'MONTHLY'] },
        date: { type: 'string', description: 'Processing date, YYYY-MM-DD. Omit for the newest instance.' },
        max_rows: { type: 'number', description: 'Default 5000, cap 50000.' },
        list_only: { type: 'boolean', description: 'List available reports without fetching one.' },
      },
      required: ['app'],
    },
    risk: 'READ',
  },
];

export const MACRO_BY_NAME = new Map(MACROS.map((m) => [m.name, m]));

/**
 * Run a read macro, or plan a write.
 *
 * Writes return a request for the caller to gate and execute, so the
 * confirmation logic lives in one place rather than being reimplemented per
 * macro — and so a macro can never accidentally bypass it.
 */
export async function runMacro(
  name: string,
  ctx: MacroContext,
  args: Record<string, any>
): Promise<{ kind: 'result'; value: unknown } | { kind: 'plan'; request: any; effect: string; context: unknown }> {
  switch (name) {
    case 'asc_pricing_get':
      return { kind: 'result', value: await pricingGet(ctx, args as any) };
    case 'asc_preflight_version':
      return { kind: 'result', value: await preflightVersion(ctx, args as any) };
    case 'asc_listing_screenshots':
      return { kind: 'result', value: await listingScreenshots(ctx, args as any) };
    case 'asc_analytics_report':
      return { kind: 'result', value: await analyticsReport(ctx, args as any) };

    case 'asc_pricing_set': {
      const plan = await planPriceChange(ctx, args as any);
      return {
        kind: 'plan',
        request: plan.request,
        effect: plan.effect,
        context: { app: plan.app, subscriptionId: plan.subscriptionId },
      };
    }

    // The upload is a sequence, not a single request, so it cannot be handed
    // back as one. It is invoked directly once the gate has cleared.
    case 'asc_upload_screenshot':
      return { kind: 'result', value: await uploadScreenshot(ctx, args as any) };

    default:
      throw new Error(`Unknown macro: ${name}`);
  }
}
