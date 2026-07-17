/**
 * Renderer wrapper for `token-category` tabs.
 *
 * `TokenManagerPanel` takes `category` + `repoPath` only, both of
 * which are present (category in `tab.data`, repoPath in
 * the active workspace root). It is therefore safe to mount standalone.
 */
import { useAtomValue } from "jotai";
import React, { memo } from "react";

import TokenManagerPanel from "@src/modules/WorkStation/Browser/Panels/BrowserMainPane/content/TokenManagerContent";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";

import type { UnifiedTabContentProps } from "../types";

const TokenCategoryTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const repoPath = useAtomValue(activeWorkspaceRootPathAtom);
    const category = String(tab.data.category ?? "");
    return <TokenManagerPanel category={category} repoPath={repoPath} />;
  }
);

TokenCategoryTabRenderer.displayName = "TokenCategoryTabRenderer";

export default TokenCategoryTabRenderer;
