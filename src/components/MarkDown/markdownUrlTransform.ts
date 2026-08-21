/**
 * URL sanitizer for the markdown renderer.
 *
 * ORG2 session references and local filesystem references can use schemes
 * (`orgii:`, `file:`, Windows drive letters, Tauri assets) that
 * react-markdown's default sanitizer rewrites to an empty href. Exactly the
 * references handled by our link renderer pass through; every other URL keeps
 * the default protocol allowlist.
 *
 * Scoped to `href` because react-markdown runs this over EVERY url-bearing
 * attribute (`src`, `poster`, `cite`, …). Only the link path has a chip
 * renderer to intercept the result; letting the scheme reach `<img src>`
 * would hand untrusted markdown a subresource load the app never handles.
 */
import { defaultUrlTransform } from "react-markdown";

import { parseCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";

import { classifyMarkdownImageSrc } from "./markdownImageSrc";

export function markdownUrlTransform(value: string, key?: string): string {
  if (key === "href") {
    if (parseCloudSessionReference(value)) return value;
    if (classifyMarkdownImageSrc(value).kind === "local") return value;
  }

  return defaultUrlTransform(value);
}
