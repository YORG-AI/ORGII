/**
 * URL sanitizer for the markdown renderer.
 *
 * ORG2 session references ride the app's own `orgii:` scheme, which
 * react-markdown's default sanitizer rewrites to an empty href. Exactly the
 * references that validate pass through; every other URL keeps the default
 * protocol allowlist, so this widens the accepted surface by nothing else —
 * not even the capability-bearing `orgii://cloud/session?share=…` form.
 *
 * Scoped to `href` because react-markdown runs this over EVERY url-bearing
 * attribute (`src`, `poster`, `cite`, …). Only the link path has a chip
 * renderer to intercept the result; letting the scheme reach `<img src>`
 * would hand untrusted markdown a subresource load the app never handles.
 */
import { defaultUrlTransform } from "react-markdown";

import { parseCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";

export function markdownUrlTransform(value: string, key?: string): string {
  return key === "href" && parseCloudSessionReference(value)
    ? value
    : defaultUrlTransform(value);
}
