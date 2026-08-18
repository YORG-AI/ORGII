/**
 * PokerTablePanel — mount point for the floating poker table ("Tables").
 *
 * Hosted by `AppLayout` over the whole pane surface next to the side chat.
 * Renders nothing until the table is opened; the window module (engine,
 * bots, `pokersolver`, components) is a separate chunk fetched on first
 * open, so a user who never plays pays nothing for the feature.
 */
import { useAtomValue } from "jotai";
import React, { Suspense } from "react";

import { pokerTableVisibleAtom } from "@src/store/ui/pokerTableAtom";

const PokerTableWindow = React.lazy(
  () => import(/* webpackChunkName: "poker-table" */ "./PokerTableWindow")
);

const PokerTablePanel: React.FC = () => {
  const visible = useAtomValue(pokerTableVisibleAtom);
  if (!visible) return null;
  return (
    <Suspense fallback={null}>
      <PokerTableWindow />
    </Suspense>
  );
};

export default PokerTablePanel;
