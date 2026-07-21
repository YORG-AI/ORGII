import { memo } from "react";

import type { TokenDefinition } from "@src/modules/WorkStation/Browser/hooks/useGlobalTokens";

import { getTokenColorStyle } from "./model";

export const TokenCard = memo(function TokenCard({
  token,
}: {
  token: TokenDefinition;
}) {
  const colorStyle = getTokenColorStyle(token);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border-2 p-2.5">
      {colorStyle ? (
        <div
          className="h-9 w-9 shrink-0 rounded border border-border-2"
          style={colorStyle}
        />
      ) : (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-fill-2 text-xs text-text-3">
          Aa
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text-1">
          --{token.name}
        </div>
        <div className="truncate text-xs text-text-3" title={token.value}>
          {token.value}
        </div>
      </div>
    </div>
  );
});
