/**
 * Preview content renderer for supported file types in session replay CodePanel.
 */
import React, { Suspense, memo } from "react";

import Markdown from "@src/components/MarkDown";
import { Placeholder } from "@src/components/Placeholder";
import { getPreviewType } from "@src/util/file/previewTypes";

import { JsonTreeView } from "../../Panels/EditorMainPane/content/FilePreviewContent";

const LazyCsvTableView = React.lazy(
  () =>
    import("../../Panels/EditorMainPane/content/FilePreviewContent/CsvTableView")
);

export const PreviewContent: React.FC<{
  filePath: string;
  content: string;
}> = memo(({ filePath, content }) => {
  const previewType = getPreviewType(filePath);

  switch (previewType) {
    case "markdown":
      return (
        <div className="scrollbar-overlay h-full overflow-auto p-4 pb-[100px]">
          <Markdown textContent={content} skipPreprocess />
        </div>
      );
    case "json":
      return <JsonTreeView content={content} className="h-full" />;
    case "csv":
      return (
        <Suspense
          fallback={
            <Placeholder
              variant="loading"
              placement="detail-panel"
              fillParentHeight
            />
          }
        >
          <LazyCsvTableView
            content={content}
            filePath={filePath}
            className="h-full"
          />
        </Suspense>
      );
    default:
      return null;
  }
});

PreviewContent.displayName = "PreviewContent";
