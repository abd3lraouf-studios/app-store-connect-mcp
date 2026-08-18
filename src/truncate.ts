/**
 * Keeping results inside the host's budget without lying about completeness.
 *
 * Claude Code warns at roughly 10k tokens of tool output and truncates at 25k.
 * Being truncated by the host is the bad outcome: it happens after the fact,
 * says nothing useful, and can cut a JSON structure in half. Trimming here
 * instead means the result stays valid and can explain itself.
 */

/** Comfortably under the host's own limit, in characters rather than tokens. */
export const DEFAULT_MAX_CHARS = 40_000;

export interface TruncationOutcome {
  text: string;
  truncated: boolean;
  /** Full text, when it did not fit and should be offered as a resource. */
  overflow?: string;
}

/**
 * Trim a JSON:API-shaped payload by dropping items from its array, rather than
 * by cutting the serialised string — a string cut produces invalid JSON, which
 * is worse than a short list.
 */
export function fitToBudget(value: unknown, maxChars = DEFAULT_MAX_CHARS): TruncationOutcome {
  const full = JSON.stringify(value, null, 2);
  if (full.length <= maxChars) return { text: full, truncated: false };

  const container = value as Record<string, unknown> | null;
  const arrayKey = container
    ? (['items', 'data', 'operations'] as const).find((k) => Array.isArray(container[k]))
    : undefined;

  if (container && arrayKey) {
    const items = container[arrayKey] as unknown[];
    // Binary search for the largest prefix that fits, so a big result loses as
    // few rows as possible.
    let low = 0;
    let high = items.length;
    let best = 0;
    let bestText = '';
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = JSON.stringify({ ...container, [arrayKey]: items.slice(0, mid) }, null, 2);
      if (candidate.length <= maxChars * 0.9) {
        best = mid;
        bestText = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const kept = JSON.parse(bestText || '{}') as Record<string, unknown>;
    kept.truncated = {
      shown: best,
      total: items.length,
      why: `The full result was ${full.length} characters, over the ${maxChars} budget.`,
      whatToDo:
        'Narrow the request rather than assuming this is everything: use fields[...] to select ' +
        'columns, filter[...] to reduce rows, or a smaller limit. The complete result is available ' +
        'as a resource — read the uri in `fullResult`.',
    };
    return { text: JSON.stringify(kept, null, 2), truncated: true, overflow: full };
  }

  // Not a shape we can trim structurally; report rather than emit broken JSON.
  return {
    text: JSON.stringify(
      {
        truncated: true,
        why: `The result was ${full.length} characters, over the ${maxChars} budget, and is not a list that can be shortened.`,
        whatToDo: 'Read the uri in `fullResult` as a resource, or request less data.',
      },
      null,
      2
    ),
    truncated: true,
    overflow: full,
  };
}
