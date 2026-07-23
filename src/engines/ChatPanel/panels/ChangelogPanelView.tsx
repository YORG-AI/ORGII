import { ChevronLeft, ChevronRight } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  CHANGELOG_RELEASES,
  type ChangelogSectionKey,
} from "@src/config/changelog/releases";

const SECTION_TONE: Record<ChangelogSectionKey, string> = {
  highlights: "bg-primary-6",
  improvements: "bg-success-6",
  fixes: "bg-warning-6",
};

export default function ChangelogPanelView(): React.ReactNode {
  const { t } = useTranslation("navigation");
  const [selectedReleaseIndex, setSelectedReleaseIndex] = useState(0);
  const release =
    CHANGELOG_RELEASES[selectedReleaseIndex] ?? CHANGELOG_RELEASES[0];
  const hasNewerRelease = selectedReleaseIndex > 0;
  const hasOlderRelease = selectedReleaseIndex < CHANGELOG_RELEASES.length - 1;
  const formattedDate = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(`${release.date}T00:00:00Z`)),
    [release.date]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-2 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-text-1">
              {release.version}
            </h2>
            {selectedReleaseIndex === 0 && (
              <span className="rounded-full bg-primary-1 px-2 py-0.5 text-xs font-medium text-primary-6">
                {t("changelog.latest")}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-text-3">{formattedDate}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            htmlType="button"
            variant="tertiary"
            size="mini"
            shape="circle"
            iconOnly
            disabled={!hasNewerRelease}
            aria-label={t("changelog.newerVersion")}
            icon={<ChevronLeft size={14} />}
            onClick={() =>
              setSelectedReleaseIndex((current) => Math.max(0, current - 1))
            }
          />
          <span className="min-w-10 text-center text-xs tabular-nums text-text-3">
            {selectedReleaseIndex + 1}/{CHANGELOG_RELEASES.length}
          </span>
          <Button
            htmlType="button"
            variant="tertiary"
            size="mini"
            shape="circle"
            iconOnly
            disabled={!hasOlderRelease}
            aria-label={t("changelog.olderVersion")}
            icon={<ChevronRight size={14} />}
            onClick={() =>
              setSelectedReleaseIndex((current) =>
                Math.min(CHANGELOG_RELEASES.length - 1, current + 1)
              )
            }
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto w-full max-w-2xl">
          <p className="text-sm leading-6 text-text-2">{release.summary}</p>
          <div className="mt-6 space-y-6">
            {release.sections.map((section) => (
              <section key={section.key}>
                <div className="mb-3 flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 rounded-full ${SECTION_TONE[section.key]}`}
                  />
                  <h3 className="text-sm font-semibold text-text-1">
                    {t(`changelog.sections.${section.key}`)}
                  </h3>
                </div>
                <ul className="space-y-2 pl-5 text-sm leading-6 text-text-2">
                  {section.items.map((item) => (
                    <li
                      key={item}
                      className="list-disc pl-1 marker:text-text-3"
                    >
                      {item}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
