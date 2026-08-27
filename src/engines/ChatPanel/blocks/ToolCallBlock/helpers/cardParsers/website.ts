/**
 * Website card parser — derives structured card data from browser/fetch tool
 * calls.
 */
import { normalizeHttpUrlCandidate } from "@src/util/url/validation";

import type { WebsiteCardData } from "../../types";

export function parseWebsiteCardResult(
  _toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>
): WebsiteCardData | null {
  const rawUrl =
    (typeof args.url === "string" ? args.url : null) ??
    (typeof args.targetUrl === "string" ? args.targetUrl : null) ??
    (typeof result.url === "string" ? result.url : null);

  if (!rawUrl) return null;
  const normalizedUrl = normalizeHttpUrlCandidate(rawUrl);
  if (!normalizedUrl) return null;

  const content =
    (typeof result.content === "string" ? result.content : null) ??
    (typeof result.output === "string" ? result.output : null) ??
    (typeof result.observation === "string" ? result.observation : null);

  let title: string | undefined;
  let description: string | undefined;

  if (content) {
    const titleMatch =
      content.match(/<title[^>]*>([^<]+)<\/title>/i) ??
      content.match(/^#\s+(.+)$/m);
    if (titleMatch) title = titleMatch[1].trim().substring(0, 100);

    const descMatch = content.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i
    );
    if (descMatch) description = descMatch[1].trim().substring(0, 200);
  }

  if (!title && typeof result.title === "string") title = result.title;

  const screenshotId =
    typeof result.screenshot_id === "string" ? result.screenshot_id : undefined;

  const favicon = `${new URL(normalizedUrl).origin}/favicon.ico`;

  return { url: normalizedUrl, title, description, screenshotId, favicon };
}
