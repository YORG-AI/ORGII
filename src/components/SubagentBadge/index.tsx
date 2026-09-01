import { useTranslation } from "react-i18next";

import SessionTitleTag from "@src/components/SessionTitleTag";

/**
 * Marks a session that was started by another session's agent rather than by
 * the user: a subagent fan-out child, an Agent Team member run, or a
 * background child.
 *
 * The breadcrumb already shows `parent › child` for these, but the parent
 * segment alone does not say *why* the child exists — a continuation and an
 * import nest the same way. The tag names the relationship. Whether a session
 * qualifies is decided by `isAgentChildSession`; this component only renders
 * the verdict, so the taxonomy keeps one definition.
 */
interface SubagentBadgeProps {
  className?: string;
}

export default function SubagentBadge({ className }: SubagentBadgeProps) {
  const { t } = useTranslation("sessions");

  return (
    <SessionTitleTag color="processing" className={className}>
      {t("sessionBadge.subagent")}
    </SessionTitleTag>
  );
}
