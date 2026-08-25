import { Loader2 } from "lucide-react";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";

import type { LanguageStat } from "./types";

interface LanguageBarProps {
  stats: LanguageStat[];
  loading: boolean;
}

const LanguageBar: React.FC<LanguageBarProps> = memo(({ stats, loading }) => {
  const { t } = useTranslation();
  const totalFiles = useMemo(
    () => stats.reduce((sum, lang) => sum + lang.fileCount, 0),
    [stats]
  );

  if (loading) {
    return (
      <div className="mb-4 flex items-center gap-2 py-2">
        <Loader2
          size={SPINNER_TOKENS.small}
          className="animate-spin text-text-3"
        />
        <span className="text-[11px] text-text-3">
          {t("placeholders.scanningFileExtensions")}
        </span>
      </div>
    );
  }

  if (stats.length === 0 || totalFiles === 0) return null;

  return (
    <div className="mb-6">
      <div className="mb-2.5 flex h-2 w-full overflow-hidden rounded-full">
        {stats.map((lang) => {
          const pct = (lang.fileCount / totalFiles) * 100;
          if (pct < 0.5) return null;
          return (
            <div
              key={lang.language}
              className="h-full transition-all"
              style={{ width: `${pct}%`, backgroundColor: lang.color }}
              title={`${lang.language}: ${lang.fileCount} ${t("labels.files")} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {stats.map((lang) => {
          const pct = ((lang.fileCount / totalFiles) * 100).toFixed(1);
          return (
            <div key={lang.language} className="flex items-center gap-1.5">
              <FileTypeIcon
                fileName={lang.iconFile}
                size="small"
                className="shrink-0"
              />
              <span className="text-[12px] text-text-2">{lang.language}</span>
              <span className="text-[11px] text-text-4">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
LanguageBar.displayName = "LanguageBar";

export default LanguageBar;
