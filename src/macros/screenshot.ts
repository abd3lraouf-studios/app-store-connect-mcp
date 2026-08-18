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

export async function uploadScreenshot(
  ctx: MacroContext,
  args: { screenshot_set_id: string; file_path: string; file_name?: string; dry_run?: boolean }
): Promise<unknown> {
  if (!fs.existsSync(args.file_path)) {
    throw new Error(`No file at ${args.file_path}.`);
  }

  const bytes = fs.readFileSync(args.file_path);
  const fileName = args.file_name ?? args.file_path.split('/').pop() ?? 'screenshot.png';
  const fileSize = bytes.byteLength;

  // Apple validates this against the assembled bytes; a mismatch fails the
  // asset rather than the request.
  const checksum = createHash('md5').update(bytes).digest('hex');

  if (args.dry_run) {
    return {
      dryRun: true,
      wouldUpload: { fileName, fileSize, md5: checksum, screenshotSetId: args.screenshot_set_id },
      sequence: [
        'POST /v1/appScreenshots (reserve)',
        'PUT each uploadOperation to Apple’s asset host',
        'PATCH /v1/appScreenshots/{id} with uploaded=true and the checksum',
      ],
      note: 'Nothing was sent.',
    };
  }

  // --- 1. Reserve --------------------------------------------------------
  const reserved = await ctx.client.request({
    baseUrl: ctx.baseUrl,
    method: 'POST',
    path: '/v1/appScreenshots',
    audience: 'connect',
    body: {
      data: {
        type: 'appScreenshots',
        attributes: { fileName, fileSize },
        relationships: {
          appScreenshotSet: { data: { type: 'appScreenshotSets', id: args.screenshot_set_id } },
        },
      },
    },
  });

  const created = (reserved.data as any).data;
  const screenshotId: string = created.id;
  const operations: UploadOperation[] = created.attributes?.uploadOperations ?? [];

  if (!operations.length) {
    throw new Error(
      `Apple reserved screenshot ${screenshotId} but returned no uploadOperations, so there is ` +
        'nowhere to send the bytes. The reservation exists and should be deleted: ' +
        `asc_write appScreenshots_deleteInstance id=${screenshotId}.`
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
      const target = new URL(op.url);
      if (target.hostname === APPLE_API_HOST) {
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
        `Screenshot ${screenshotId} is reserved but incomplete and will sit in AWAITING_UPLOAD. ` +
        `Remove it with asc_write appScreenshots_deleteInstance id=${screenshotId}, then retry.`
    );
  }

  // --- 3. Commit ---------------------------------------------------------
  const committed = await ctx.client.request({
    baseUrl: ctx.baseUrl,
    method: 'PATCH',
    path: `/v1/appScreenshots/${screenshotId}`,
    audience: 'connect',
    body: {
      data: {
        type: 'appScreenshots',
        id: screenshotId,
        attributes: { uploaded: true, sourceFileChecksum: checksum },
      },
    },
  });

  const state = (committed.data as any).data?.attributes?.assetDeliveryState;

  return {
    screenshotId,
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
          `asc_call appScreenshots_getInstance id=${screenshotId}. A FAILED state carries the reason in assetDeliveryState.errors — ` +
          'usually the image dimensions not matching the set’s display type.',
  };
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
