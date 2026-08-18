/**
 * "Can this version actually ship?"
 *
 * The calls are ordinary; the checklist is the point. Each item below is a
 * state Apple will refuse on — or silently stall on — without saying so
 * anywhere obvious in the API response. Several of them present as *nothing
 * happening*, which is exactly what a person cannot debug from a tool result.
 *
 * Every gap names the operation that fixes it, so the answer is actionable
 * rather than a list of complaints.
 */
import { get, getAll, resolveApp, type MacroContext } from './support.js';

interface Finding {
  severity: 'blocking' | 'warning';
  what: string;
  why: string;
  fix: string;
}

export async function preflightVersion(
  ctx: MacroContext,
  args: { app: string; version?: string }
): Promise<unknown> {
  const app = await resolveApp(ctx, args.app);
  const findings: Finding[] = [];

  const versions = await getAll(ctx, `/v1/apps/${app.id}/appStoreVersions`, {
    'fields[appStoreVersions]': 'versionString,appStoreState,appVersionState,platform,releaseType,createdDate',
    limit: 20,
  });

  if (!versions.length) {
    throw new Error(`${app.bundleId} has no App Store versions.`);
  }

  const version = args.version
    ? versions.find((v: any) => v.attributes?.versionString === args.version)
    : versions[0];

  if (!version) {
    throw new Error(
      `No version "${args.version}" on ${app.bundleId}. Found: ` +
        versions.map((v: any) => v.attributes?.versionString).join(', ')
    );
  }

  const state = version.attributes?.appStoreState ?? version.attributes?.appVersionState;

  // --- Build -------------------------------------------------------------
  let build: any;
  try {
    const body = await get(ctx, `/v1/appStoreVersions/${version.id}/build`, {
      'fields[builds]': 'version,processingState,expired,expirationDate,usesNonExemptEncryption,uploadedDate',
    });
    build = body.data;
  } catch {
    build = undefined;
  }

  if (!build) {
    findings.push({
      severity: 'blocking',
      what: 'No build is attached to this version.',
      why: 'A version cannot be submitted without one.',
      fix: 'Attach a processed build: asc_write appStoreVersions_updateInstance, or check builds with asc_call builds_getCollection.',
    });
  } else {
    if (build.attributes?.processingState === 'PROCESSING') {
      findings.push({
        severity: 'blocking',
        what: `Build ${build.attributes.version} is still PROCESSING.`,
        why: 'A processing build cannot be attached or submitted, and Apple gives no estimate for when it will finish.',
        fix: 'Wait and re-check: asc_call builds_getInstance.',
      });
    }
    if (build.attributes?.processingState === 'FAILED' || build.attributes?.processingState === 'INVALID') {
      findings.push({
        severity: 'blocking',
        what: `Build ${build.attributes.version} is ${build.attributes.processingState}.`,
        why: 'Apple rejected the binary during processing.',
        fix: 'Upload a new build. The reason is usually in the email Apple sent, not in this API.',
      });
    }
    if (build.attributes?.expired) {
      findings.push({
        severity: 'blocking',
        what: `Build ${build.attributes.version} has expired.`,
        why: 'Expired builds cannot be submitted.',
        fix: 'Upload a fresh build.',
      });
    }
    // The one that strands a release with no visible explanation.
    if (build.attributes?.usesNonExemptEncryption === null || build.attributes?.usesNonExemptEncryption === undefined) {
      findings.push({
        severity: 'blocking',
        what: 'Export compliance is unanswered (usesNonExemptEncryption is null).',
        why: 'The version parks at WAITING_FOR_EXPORT_COMPLIANCE. Nothing in the API explains why, and it looks like the submission simply stopped.',
        fix: 'Set it: asc_write builds_updateInstance with attributes.usesNonExemptEncryption.',
      });
    }
  }

  // --- Localisations -----------------------------------------------------
  // Every locale, paged. Checking only the primary one is how a missing
  // description in locale 34 reaches App Review.
  const locales = await getAll(ctx, `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`, {
    'fields[appStoreVersionLocalizations]': 'locale,description,keywords,whatsNew,supportUrl',
    limit: 200,
  });

  for (const loc of locales) {
    const a = loc.attributes ?? {};
    if (!a.description) {
      findings.push({
        severity: 'blocking',
        what: `Locale ${a.locale} has no description.`,
        why: 'Apple requires a description for every locale present on the version.',
        fix: `asc_write appStoreVersionLocalizations_updateInstance for id ${loc.id}.`,
      });
    }
    if (!a.supportUrl) {
      findings.push({
        severity: 'warning',
        what: `Locale ${a.locale} has no support URL.`,
        why: 'Usually required; App Review rejects for it.',
        fix: `asc_write appStoreVersionLocalizations_updateInstance for id ${loc.id}.`,
      });
    }
    if ((a.keywords?.length ?? 0) > 100) {
      findings.push({
        severity: 'blocking',
        what: `Locale ${a.locale} exceeds the 100-character keyword limit (${a.keywords.length}).`,
        why: 'The limit counts the commas as well as the words.',
        fix: `asc_write appStoreVersionLocalizations_updateInstance for id ${loc.id}.`,
      });
    }
  }

  if (!locales.length) {
    findings.push({
      severity: 'blocking',
      what: 'The version has no localisations at all.',
      why: 'Nothing can be shown on the store listing.',
      fix: 'asc_write appStoreVersionLocalizations_createInstance.',
    });
  }

  // --- Screenshots -------------------------------------------------------
  let screenshotSets = 0;
  if (locales.length) {
    const sets = await getAll(
      ctx,
      `/v1/appStoreVersionLocalizations/${locales[0].id}/appScreenshotSets`,
      { 'fields[appScreenshotSets]': 'screenshotDisplayType', limit: 50 }
    );
    screenshotSets = sets.length;
    if (!sets.length) {
      findings.push({
        severity: 'blocking',
        what: `Locale ${locales[0].attributes?.locale} has no screenshot sets.`,
        why: 'At least one display size is required.',
        fix: 'asc_upload_screenshot, or asc_write appScreenshotSets_createInstance.',
      });
    }
  }

  // --- Review detail -----------------------------------------------------
  let reviewDetail: any;
  try {
    const body = await get(ctx, `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`, {
      'fields[appStoreReviewDetails]':
        'contactFirstName,contactLastName,contactEmail,contactPhone,demoAccountRequired,demoAccountName,demoAccountPassword,notes',
    });
    reviewDetail = body.data;
  } catch {
    reviewDetail = undefined;
  }

  const rd = reviewDetail?.attributes ?? {};
  if (!reviewDetail) {
    findings.push({
      severity: 'blocking',
      what: 'No App Review detail on this version.',
      why: 'Apple needs a contact for review.',
      fix: 'asc_write appStoreReviewDetails_createInstance.',
    });
  } else {
    if (!rd.contactEmail || !rd.contactPhone) {
      findings.push({
        severity: 'blocking',
        what: 'App Review contact details are incomplete.',
        why: 'Apple requires an email and a phone number.',
        fix: `asc_write appStoreReviewDetails_updateInstance for id ${reviewDetail.id}.`,
      });
    }
    if (rd.demoAccountRequired && (!rd.demoAccountName || !rd.demoAccountPassword)) {
      findings.push({
        severity: 'blocking',
        what: 'A demo account is marked required but the credentials are blank.',
        why: 'App Review cannot sign in, and this is among the most common rejections.',
        fix: `asc_write appStoreReviewDetails_updateInstance for id ${reviewDetail.id}.`,
      });
    }
  }

  // --- Open submission ---------------------------------------------------
  const submissions = await getAll(ctx, `/v1/apps/${app.id}/reviewSubmissions`, {
    'fields[reviewSubmissions]': 'state,platform,submittedDate',
    'filter[state]': 'READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES',
    limit: 10,
  }).catch(() => []);

  if (submissions.length) {
    findings.push({
      severity: 'warning',
      what: `There is already an open review submission (${submissions[0].attributes?.state}).`,
      why: 'A second submission cannot be created while one is open.',
      fix: 'Finish or cancel it first: asc_call reviewSubmissions_getCollection.',
    });
  }

  const blocking = findings.filter((f) => f.severity === 'blocking');
  const warnings = findings.filter((f) => f.severity === 'warning');

  return {
    app,
    version: {
      id: version.id,
      versionString: version.attributes?.versionString,
      state,
      platform: version.attributes?.platform,
    },
    verdict: blocking.length ? 'NO-GO' : 'GO',
    summary: blocking.length
      ? `${blocking.length} blocking issue${blocking.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`
      : `Ready to submit. ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`,
    blocking,
    warnings,
    checked: {
      build: build ? `${build.attributes?.version} (${build.attributes?.processingState})` : 'none',
      localizations: locales.length,
      screenshotSetsInPrimaryLocale: screenshotSets,
      reviewDetail: reviewDetail ? 'present' : 'missing',
      openSubmissions: submissions.length,
    },
    note: 'Read-only. Nothing was changed.',
  };
}
