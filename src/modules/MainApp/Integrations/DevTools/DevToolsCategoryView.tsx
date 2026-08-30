import React, { Suspense, lazy } from "react";

import { Placeholder } from "@src/components/Placeholder";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InternalHeader,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";

import { ThirdPartyDisclaimer } from "../Tables/TrademarkDisclaimer";

const DependenciesPage = lazy(() => import("./DependenciesPage"));

/**
 * Dev Tools category — Dependencies only.
 *
 * The LSP and Lint tabs were archived along with the rest of the
 * user-facing LSP/lint surface (see `.archive/README.md`); language servers
 * and lint tools are now an agent-only capability.
 */
const DevToolsCategoryView: React.FC = () => {
  const depsRefreshRef = React.useRef<(() => Promise<void>) | null>(null);

  return (
    <DetailPanelContainer>
      <InternalHeader
        noPanelHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
      />
      <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
          <div className="flex flex-col gap-3">
            <Suspense
              fallback={
                <Placeholder variant="loading" placement="detail-panel" />
              }
            >
              <DependenciesPage refreshRef={depsRefreshRef} />
            </Suspense>
            <ThirdPartyDisclaimer />
          </div>
        </div>
      </ScrollPreservation>
    </DetailPanelContainer>
  );
};

export default DevToolsCategoryView;
