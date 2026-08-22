/**
 * Analytics: the five-hop chain that ends in a gzipped TSV.
 *
 *   analyticsReportRequests → reports → instances (by date) → segments
 *   → each segment's signed URL → gunzip → parse TSV
 *
 * Two things make this worth a macro rather than five `asc_call`s.
 *
 * First, **segments must all be read**. A report is split into numbered
 * segments, and reading only the first returns a plausible-looking subset with
 * nothing marking it as partial — the single most likely way to get a
 * confidently wrong number out of this API.
 *
 * Second, the payload is not JSON. Segment URLs return gzip-compressed
 * tab-separated data from a different host, so a caller doing this by hand
 * gets a binary blob and no rows.
 *
 * Creating a report request is deliberately NOT done here. `accessType:
 * ONGOING` is a standing commitment on the account, not a query, and creating
 * one to answer a single question leaves it running indefinitely.
 */
import { gunzipSync } from 'node:zlib';
import { getAll, resolveApp, type MacroContext } from './support.js';
import { recordFailure } from '../failure-log.js';

/** A pre-signed URL is a credential; only its host is safe to record. */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Segment URLs are pre-signed on a different host and take no bearer token. */
async function fetchSegment(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    // Hostname only. The signature that makes this URL work lives in its path
    // and query, so the URL itself is a credential.
    recordFailure({
      kind: 'segment-download',
      message: `Segment download failed with HTTP ${res.status}.`,
      status: res.status,
      host: hostnameOf(url),
    });
    throw new Error(`Segment download failed with HTTP ${res.status}.`);
  }

  const raw = Buffer.from(await res.arrayBuffer());
  // Apple gzips these; sniff the magic rather than trusting Content-Encoding,
  // which fetch may already have handled.
  const gzipped = raw[0] === 0x1f && raw[1] === 0x8b;
  return (gzipped ? gunzipSync(raw) : raw).toString('utf8');
}

function parseTsv(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const lines = text.split('\n').filter((l) => l.length);
  if (!lines.length) return { columns: [], rows: [] };
  const columns = (lines[0] as string).split('\t');
  const rows = lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? '']));
  });
  return { columns, rows };
}

export async function analyticsReport(
  ctx: MacroContext,
  args: {
    app: string;
    report_name?: string;
    granularity?: 'DAILY' | 'WEEKLY' | 'MONTHLY';
    date?: string;
    max_rows?: number;
    list_only?: boolean;
  }
): Promise<unknown> {
  const app = await resolveApp(ctx, args.app);

  const requests = await getAll(ctx, `/v1/apps/${app.id}/analyticsReportRequests`, {
    'fields[analyticsReportRequests]': 'accessType,stoppedDueToInactivity',
    limit: 50,
  });

  if (!requests.length) {
    throw new Error(
      `${app.bundleId} has no analytics report requests, so Apple is not generating any reports for it.\n\n` +
        'One must be created before any data exists — but note that accessType ONGOING is a standing ' +
        'commitment on the account, not a one-off query. This tool will not create one silently. ' +
        'If you intend to: asc_write analyticsReportRequests_createInstance.'
    );
  }

  const active = requests.filter((r: any) => !r.attributes?.stoppedDueToInactivity);
  const usable = active.length ? active : requests;

  // Collect the available reports across every request.
  const reports: any[] = [];
  for (const req of usable) {
    const found = await getAll(ctx, `/v1/analyticsReportRequests/${req.id}/reports`, {
      'fields[analyticsReports]': 'name,category',
      limit: 200,
    });
    for (const r of found) {
      reports.push({ ...r, accessType: req.attributes?.accessType, requestId: req.id });
    }
  }

  if (args.list_only || !args.report_name) {
    return {
      app,
      requests: usable.map((r: any) => ({
        id: r.id,
        accessType: r.attributes?.accessType,
        stoppedDueToInactivity: r.attributes?.stoppedDueToInactivity ?? false,
      })),
      reports: reports.map((r) => ({
        name: r.attributes?.name,
        category: r.attributes?.category,
        id: r.id,
        accessType: r.accessType,
      })),
      note: reports.length
        ? 'Pass report_name to fetch one. Apple generates these on its own schedule; a report with no instances yet is normal on a recently created request.'
        : 'No reports available yet. Apple can take a day or more after a request is created.',
    };
  }

  const report =
    reports.find((r) => r.attributes?.name === args.report_name) ??
    reports.find((r) => r.attributes?.name?.toLowerCase().includes(args.report_name!.toLowerCase()));

  if (!report) {
    throw new Error(
      `No report named "${args.report_name}". Available: ` +
        (reports.map((r) => r.attributes?.name).join(', ') || '(none yet)')
    );
  }

  // --- Instances ---------------------------------------------------------
  const instanceQuery: Record<string, unknown> = {
    'fields[analyticsReportInstances]': 'granularity,processingDate',
    limit: 100,
  };
  if (args.granularity) instanceQuery['filter[granularity]'] = args.granularity;
  if (args.date) instanceQuery['filter[processingDate]'] = args.date;

  const instances = await getAll(ctx, `/v1/analyticsReports/${report.id}/instances`, instanceQuery);
  if (!instances.length) {
    return {
      app,
      report: { id: report.id, name: report.attributes?.name, category: report.attributes?.category },
      instances: 0,
      note:
        'The report exists but has no instances for that filter. Apple generates instances on its own ' +
        'schedule; a freshly created request has none for a day or more. Drop the date filter to see what exists.',
    };
  }

  // Newest first, so an unfiltered call answers "the latest data".
  instances.sort((a: any, b: any) =>
    String(b.attributes?.processingDate ?? '').localeCompare(String(a.attributes?.processingDate ?? ''))
  );
  const instance = instances[0];

  // --- Segments: all of them --------------------------------------------
  const segments = await getAll(ctx, `/v1/analyticsReportInstances/${instance.id}/segments`, {
    'fields[analyticsReportSegments]': 'checksum,sizeInBytes,url',
    limit: 100,
  });

  if (!segments.length) {
    return {
      app,
      report: { id: report.id, name: report.attributes?.name },
      instance: { id: instance.id, processingDate: instance.attributes?.processingDate },
      segments: 0,
      note: 'The instance exists but has no segments, which usually means there was no data for that period.',
    };
  }

  const maxRows = Math.min(args.max_rows ?? 5000, 50_000);
  let columns: string[] = [];
  const rows: Record<string, string>[] = [];
  let truncated = false;

  for (const segment of segments) {
    const url = segment.attributes?.url;
    if (!url) continue;
    const parsed = parseTsv(await fetchSegment(url));
    if (!columns.length) columns = parsed.columns;
    for (const row of parsed.rows) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    if (truncated) break;
  }

  return {
    app,
    report: { id: report.id, name: report.attributes?.name, category: report.attributes?.category },
    instance: {
      id: instance.id,
      granularity: instance.attributes?.granularity,
      processingDate: instance.attributes?.processingDate,
    },
    // Stated explicitly, because a partial stitch is otherwise invisible.
    segments: { total: segments.length, allRead: !truncated },
    columns,
    rowCount: rows.length,
    rows,
    ...(truncated
      ? {
          truncated: `Stopped at ${maxRows} rows before reading every segment. Raise max_rows, or narrow with granularity/date.`,
        }
      : {}),
    otherInstances: instances.slice(1, 6).map((i: any) => ({
      id: i.id,
      processingDate: i.attributes?.processingDate,
      granularity: i.attributes?.granularity,
    })),
  };
}
