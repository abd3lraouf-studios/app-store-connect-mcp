/**
 * Uploading a screenshot — the one thing here the raw API genuinely cannot do
 * in a single call.
 *
 * Apple's sequence is reserve → upload → commit:
 *
 *   1. POST /v1/appScreenshots with fileName and fileSize. The response
 *      carries `uploadOperations`: a list of {method, url, offset, length,
 *      requestHeaders} describing byte ranges to PUT.
 *   2. PUT each range **to a different host**, with Apple-supplied headers.
 *      Those URLs are pre-signed and must NOT carry our bearer token.
 *   3. PATCH the screenshot with `uploaded: true` and an MD5 of the whole
 *      file, which is what tells Apple to assemble and validate it.
 *
 * `uploadOperations` appears in the OpenAPI document only as a value in a
 * `fields[]` enum, so an agent reading the spec can see the field exists and
 * still have no idea it must act on it. Getting the checksum or the offsets
 * wrong does not error — it leaves the asset stuck in AWAITING_UPLOAD or
 * FAILED, which looks like nothing happened.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { get, getAll, resolveApp, type MacroContext } from './support.js';

/** Apple's own hosts are the only ones our bearer token may reach. */
const APPLE_API_HOST = 'api.appstoreconnect.apple.com';

interface UploadOperation {
  method: string;
  url: string;
  offset: number;
  length: number;
  requestHeaders?: Array<{ name: string; value: string }>;
}

/**
 * What differs between one asset kind and the next.
 *
 * The reserve → upload → commit sequence is identical for every asset Apple
 * accepts — listing screenshots, app previews, IAP and subscription review
 * screenshots all use the same `uploadOperations` contract and the same
 * `uploaded` + `sourceFileChecksum` commit. Only the resource names change, so
 * they are the only thing parameterised. Adding a new asset kind is a
 * descriptor, not another copy of the upload logic.
 */
interface AssetTarget {
  /** Collection to POST the reservation to. */
  createPath: string;
  /** JSON:API `type` for both the reservation and the commit. */
  jsonApiType: string;
  /** Relationship naming the parent, and the parent's own JSON:API type. */
  parentRelName: string;
  parentRelType: string;
  /** Named in the cleanup instructions when a reservation is left dangling. */
  deleteOpId: string;
  /** Used when the caller supplies neither a name nor a usable path. */
  defaultFileName: string;
  /** Read back a reserved asset, for the "still validating" hint. */
  readOpId: string;
}

const LISTING_SCREENSHOT: AssetTarget = {
  createPath: '/v1/appScreenshots',
  jsonApiType: 'appScreenshots',
  parentRelName: 'appScreenshotSet',
  parentRelType: 'appScreenshotSets',
  deleteOpId: 'appScreenshots_deleteInstance',
  readOpId: 'appScreenshots_getInstance',
  defaultFileName: 'screenshot.png',
};

const IAP_REVIEW_SCREENSHOT: AssetTarget = {
  createPath: '/v1/inAppPurchaseAppStoreReviewScreenshots',
  jsonApiType: 'inAppPurchaseAppStoreReviewScreenshots',
  parentRelName: 'inAppPurchaseV2',
  parentRelType: 'inAppPurchases',
  deleteOpId: 'inAppPurchaseAppStoreReviewScreenshots_deleteInstance',
  readOpId: 'inAppPurchaseAppStoreReviewScreenshots_getInstance',
  defaultFileName: 'iap-review-screenshot.png',
};

async function uploadAsset(
  ctx: MacroContext,
  target: AssetTarget,
  parentId: string,
  args: { file_path: string; file_name?: string; dry_run?: boolean }
): Promise<unknown> {
  if (!fs.existsSync(args.file_path)) {
    throw new Error(`No file at ${args.file_path}.`);
  }

  const bytes = fs.readFileSync(args.file_path);
  const fileName = args.file_name ?? args.file_path.split('/').pop() ?? target.defaultFileName;
  const fileSize = bytes.byteLength;

  // Apple validates this against the assembled bytes; a mismatch fails the
  // asset rather than the request.
  const checksum = createHash('md5').update(bytes).digest('hex');

  if (args.dry_run) {
    return {
      dryRun: true,
      wouldUpload: { fileName, fileSize, md5: checksum, parentId, resource: target.createPath },
      sequence: [
        `POST ${target.createPath} (reserve)`,
        'PUT each uploadOperation to Apple’s asset host',
        `PATCH ${target.createPath}/{id} with uploaded=true and the checksum`,
      ],
      note: 'Nothing was sent.',
    };
  }

  // --- 1. Reserve --------------------------------------------------------
  const reserved = await ctx.client.request({
    baseUrl: ctx.baseUrl,
    method: 'POST',
    path: target.createPath,
    audience: 'connect',
    body: {
      data: {
        type: target.jsonApiType,
        attributes: { fileName, fileSize },
        relationships: {
          [target.parentRelName]: { data: { type: target.parentRelType, id: parentId } },
        },
      },
    },
  });

  const created = (reserved.data as any).data;
  const assetId: string = created.id;
  const operations: UploadOperation[] = created.attributes?.uploadOperations ?? [];

  if (!operations.length) {
    throw new Error(
      `Apple reserved ${assetId} but returned no uploadOperations, so there is ` +
        'nowhere to send the bytes. The reservation exists and should be deleted: ' +
        `asc_write ${target.deleteOpId} id=${assetId}.`
    );
  }

  // --- 2. Upload the byte ranges ----------------------------------------
  const uploaded: Array<{ offset: number; length: number; status: number }> = [];
  try {
    for (const op of operations) {
      const headers: Record<string, string> = {};
      for (const h of op.requestHeaders ?? []) headers[h.name] = h.value;

      // These are pre-signed URLs on a different host. Sending our
      // Authorization header here would hand a live App Store Connect token
      // to whatever Apple happened to name.
      const url = new URL(op.url);
      if (url.hostname === APPLE_API_HOST) {
        throw new Error('Refusing to replay an upload operation against the authenticated API host.');
      }

      const res = await fetch(op.url, {
        method: op.method,
        headers,
        body: bytes.subarray(op.offset, op.offset + op.length),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        throw new Error(
          `Upload of bytes ${op.offset}–${op.offset + op.length} failed with HTTP ${res.status}.`
        );
      }
      uploaded.push({ offset: op.offset, length: op.length, status: res.status });
    }
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\n` +
        `Asset ${assetId} is reserved but incomplete and will sit in AWAITING_UPLOAD. ` +
        `Remove it with asc_write ${target.deleteOpId} id=${assetId}, then retry.`
    );
  }

  // --- 3. Commit ---------------------------------------------------------
  const committed = await ctx.client.request({
    baseUrl: ctx.baseUrl,
    method: 'PATCH',
    path: `${target.createPath}/${assetId}`,
    audience: 'connect',
    body: {
      data: {
        type: target.jsonApiType,
        id: assetId,
        attributes: { uploaded: true, sourceFileChecksum: checksum },
      },
    },
  });

  const state = (committed.data as any).data?.attributes?.assetDeliveryState;

  return {
    assetId,
    fileName,
    fileSize,
    md5: checksum,
    chunksUploaded: uploaded.length,
    assetDeliveryState: state,
    // COMPLETE can take a moment; Apple validates dimensions asynchronously.
    note:
      state?.state === 'COMPLETE'
        ? 'Upload complete and accepted.'
        : `Apple is still validating (state: ${state?.state ?? 'unknown'}). Re-read with ` +
          `asc_call ${target.readOpId} id=${assetId}. A FAILED state carries the reason in ` +
          'assetDeliveryState.errors — usually the image dimensions, and for review screenshots ' +
          'usually IMAGE_BAD_ASPECT_RATIO.',
  };
}

export async function uploadScreenshot(
  ctx: MacroContext,
  args: { screenshot_set_id: string; file_path: string; file_name?: string; dry_run?: boolean }
): Promise<unknown> {
  const result = await uploadAsset(ctx, LISTING_SCREENSHOT, args.screenshot_set_id, args);
  // `screenshotId` was this tool's field name before the upload became generic.
  const { assetId, ...rest } = result as { assetId?: string };
  return assetId ? { screenshotId: assetId, ...rest } : result;
}

/**
 * The review screenshot Apple shows the reviewer for an in-app purchase.
 *
 * A different resource from a listing screenshot, and the reason an IAP sits in
 * MISSING_METADATA when everything else about it is complete — it is the one
 * required field with no text to fill in.
 */
export async function uploadIapScreenshot(
  ctx: MacroContext,
  args: { iap: string; file_path: string; file_name?: string; dry_run?: boolean }
): Promise<unknown> {
  const iapId = resolveIap(args.iap);
  return uploadAsset(ctx, IAP_REVIEW_SCREENSHOT, iapId, args);
}

/** Only the numeric id addresses an in-app purchase; say so usefully. */
function resolveIap(iap: string): string {
  if (/^\d+$/.test(iap)) return iap;
  throw new Error(
    `"${iap}" is not a numeric in-app purchase id. Product IDs are not addressable directly — ` +
      'find the id with asc_call apps_inAppPurchasesV2_getToManyRelated, or asc_pricing_get, ' +
      'which lists every in-app purchase with its id and productId.'
  );
}

/**
 * The listing read: app → version → localisations → sets → screenshots.
 *
 * Walked naively this is one request per locale per set — over fifty for a
 * fully localised app. Requesting the nested resources as `included` collapses
 * it to a handful.
 */
export async function listingScreenshots(
  ctx: MacroContext,
  args: { app: string; version?: string; locale?: string }
): Promise<unknown> {
  const app = await resolveApp(ctx, args.app);

  const versions = await getAll(ctx, `/v1/apps/${app.id}/appStoreVersions`, {
    'fields[appStoreVersions]': 'versionString,appStoreState',
    limit: 20,
  });
  const version = args.version
    ? versions.find((v: any) => v.attributes?.versionString === args.version)
    : versions[0];
  if (!version) throw new Error(`No version "${args.version ?? 'latest'}" on ${app.bundleId}.`);

  const locales = await getAll(ctx, `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`, {
    'fields[appStoreVersionLocalizations]': 'locale',
    limit: 200,
  });

  const wanted = args.locale
    ? locales.filter((l: any) => l.attributes?.locale === args.locale)
    : locales;
  if (!wanted.length) {
    throw new Error(
      `No localisation for "${args.locale}". Present: ${locales.map((l: any) => l.attributes?.locale).join(', ')}`
    );
  }

  // Reading every locale's screenshots is rarely what anyone wants and costs a
  // request per locale, so default to the first and say what was skipped.
  const inspect = args.locale ? wanted : wanted.slice(0, 1);
  const perLocale = [];

  for (const loc of inspect) {
    const body = await get(ctx, `/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`, {
      include: 'appScreenshots',
      'fields[appScreenshotSets]': 'screenshotDisplayType,appScreenshots',
      'fields[appScreenshots]': 'fileName,fileSize,assetDeliveryState',
      limit: 50,
    });
    const shots = new Map((body.included ?? []).map((i: any) => [i.id, i]));

    perLocale.push({
      locale: loc.attributes?.locale,
      sets: (body.data ?? []).map((set: any) => ({
        id: set.id,
        displayType: set.attributes?.screenshotDisplayType,
        screenshots: (set.relationships?.appScreenshots?.data ?? []).map((ref: any) => {
          const s: any = shots.get(ref.id);
          return {
            id: ref.id,
            fileName: s?.attributes?.fileName,
            fileSize: s?.attributes?.fileSize,
            state: s?.attributes?.assetDeliveryState?.state,
          };
        }),
      })),
    });
  }

  return {
    app,
    version: { id: version.id, versionString: version.attributes?.versionString },
    localesOnVersion: locales.length,
    inspected: perLocale,
    note: args.locale
      ? undefined
      : `Showing 1 of ${locales.length} locales. Pass "locale" to inspect a specific one; ` +
        'the others typically inherit the primary locale’s screenshots unless overridden.',
  };
}
