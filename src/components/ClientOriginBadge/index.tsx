import { useTranslation } from "react-i18next";

import type { ImportedClientOrigin } from "@src/api/tauri/externalHistory/imported/descriptors";
import SessionTitleTag from "@src/components/SessionTitleTag";

/**
 * Provenance badge for an imported session: which client actually produced
 * the transcript.
 *
 * Sources are not one-client-per-store — `~/.codex/sessions` holds rollouts
 * from the Codex desktop app, the `codex` CLI, third-party SDK embedders, and
 * ORGII itself — so the source name alone does not tell a viewer where a
 * session came from. The classification is resolved once by
 * `resolveSessionDisplayMetadata`; this component only renders it, so the
 * sidebar, hover cards, and the chat header cannot drift apart.
 *
 * ORGII's own sessions render nothing: inside ORGII, "ORGII drove this" is
 * the unmarked default, and badging it would put a label on the majority of
 * rows that carries no information.
 */
export interface ClientOriginBadgeProps {
  origin: ImportedClientOrigin | undefined;
  /**
   * Raw vendor string (`multica-agent-sdk`, `claude-desktop`). Shown as the
   * title so "Third party" can be resolved to an actual name on hover.
   */
  originRaw?: string;
  size?: "mini" | "small";
  className?: string;
}

/** Tag colors per origin. `org2` is absent: it never renders. */
const ORIGIN_COLOR: Record<
  Exclude<ImportedClientOrigin, "org2">,
  "default" | "primary" | "processing"
> = {
  official_app: "primary",
  cli: "processing",
  third_party: "default",
};

const ORIGIN_LABEL_KEY: Record<
  Exclude<ImportedClientOrigin, "org2">,
  string
> = {
  official_app: "clientOrigin.officialApp",
  cli: "clientOrigin.cli",
  third_party: "clientOrigin.thirdParty",
};

/**
 * Whether this origin renders a badge at all. Callers that need to know
 * before laying out a row (to avoid an empty wrapper) must ask here rather
 * than re-deriving the rule, so suppression stays defined once.
 */
export function hasVisibleClientOriginBadge(
  origin: ImportedClientOrigin | undefined
): origin is Exclude<ImportedClientOrigin, "org2"> {
  return origin !== undefined && origin !== "org2";
}

export default function ClientOriginBadge({
  origin,
  originRaw,
  size = "mini",
  className,
}: ClientOriginBadgeProps) {
  const { t } = useTranslation("common");

  // Absent provenance and ORGII's own sessions both render nothing — the
  // first because we do not know, the second because it is the default.
  if (!hasVisibleClientOriginBadge(origin)) return null;

  return (
    <SessionTitleTag
      color={ORIGIN_COLOR[origin]}
      size={size}
      title={originRaw}
      className={className}
    >
      {t(ORIGIN_LABEL_KEY[origin])}
    </SessionTitleTag>
  );
}
