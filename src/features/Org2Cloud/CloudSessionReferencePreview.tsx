/**
 * Live chip preview for session references inside a plain-text composer —
 * the issue comment box and the create-issue body, where a dragged session
 * lands as a bare `orgii://cloud/session/ref` URL.
 *
 * A native textarea cannot render inline pills, and the published comment
 * is markdown that GitHub's own UI shows as raw text anyway, so the text
 * stays the source of truth. This strip renders under the editor instead:
 * the same `CloudSessionReferenceChip` the rendered body will show, backed
 * by the same scanner the markdown linkifier uses, so the preview never
 * disagrees with the published rendering. No references → renders nothing.
 *
 * Chips render passive (`interactive={false}`): a preview exists to answer
 * "which session did I just reference", and navigating away mid-draft —
 * or inserting tab stops between the textarea and the submit button —
 * would fight the composing flow it sits in.
 *
 * Two guards keep per-keystroke cost negligible:
 * - the scan runs on a deferred copy of the text, so a pathological paste
 *   (huge minified blob dense with scheme hits) can never block the urgent
 *   input render, and
 * - the reference array keeps its previous identity whenever the scanned
 *   set is unchanged, so the memoized chips actually skip re-rendering
 *   while the user types around them.
 */
import { memo, useDeferredValue, useMemo } from "react";

import { CloudSessionReferenceChip } from "./CloudSessionReferenceChip";
import {
  type CloudSessionReference,
  collectUniqueCloudSessionReferences,
} from "./cloudSessionReference";

function referenceKey(reference: CloudSessionReference): string {
  // \u001f separators: the ids are free text out of a URL, so plain
  // concatenation or colon joins could collide two distinct references.
  return `${reference.orgId}\u001f${reference.ownerUserId}\u001f${reference.sourceSessionId}`;
}

export const CloudSessionReferencePreview = memo(
  function CloudSessionReferencePreview({
    text,
    className = "",
  }: {
    text: string;
    className?: string;
  }) {
    const deferredText = useDeferredValue(text);
    const scanned = useMemo(
      () => collectUniqueCloudSessionReferences(deferredText),
      [deferredText]
    );
    const scannedKey = useMemo(
      () => scanned.map(referenceKey).join("\n"),
      [scanned]
    );
    // Identity stabilization: the chips are memo'd on their reference prop,
    // and every keystroke reallocates `scanned` even when the reference SET
    // is unchanged. Keying this memo on the content key returns the array
    // captured when the key last changed, so unchanged chips skip
    // re-rendering while the user types around them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const references = useMemo(() => scanned, [scannedKey]);
    if (references.length === 0) return null;
    return (
      // Pills carry their own 2px margins (they are built for inline flow),
      // so gap-1 composes to the 8px rhythm of sibling gap-2 chip rows and
      // the negative margin returns the first pill to the flush left edge.
      <div
        className={`-mx-0.5 flex flex-wrap items-center gap-1 ${className}`.trim()}
        data-testid="session-reference-preview"
      >
        {references.map((reference) => (
          <CloudSessionReferenceChip
            key={referenceKey(reference)}
            reference={reference}
            interactive={false}
          />
        ))}
      </div>
    );
  }
);
