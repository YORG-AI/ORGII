import type { TFunction } from "i18next";
import { Palette } from "lucide-react";

import type { TokenCategory } from "@src/modules/WorkStation/Browser/hooks/useGlobalTokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import DesignFileBar from "../../components/DesignFileBar";
import { TokenCard } from "./TokenCard";

interface SingleTokenCategoryViewProps {
  category: string;
  categoryData?: TokenCategory;
  loading: boolean;
  error: string | null;
  onRetry: () => Promise<void>;
  t: TFunction;
}

export function SingleTokenCategoryView({
  category,
  categoryData,
  loading,
  error,
  onRetry,
  t,
}: SingleTokenCategoryViewProps) {
  return (
    <div className="flex h-full flex-col">
      <DesignFileBar
        icon={Palette}
        segments={[
          { text: "Design Tokens" },
          {
            text: category,
            primary: true,
            capitalize: true,
            secondary: String(categoryData?.tokens.length ?? 0),
          },
        ]}
      />
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <Placeholder
            variant="loading"
            placement="detail-panel"
            fillParentHeight
          />
        ) : error ? (
          <Placeholder
            variant="error"
            placement="detail-panel"
            title={error}
            onRetry={onRetry}
            fillParentHeight
          />
        ) : !categoryData ? (
          <Placeholder
            variant="error"
            placement="detail-panel"
            title={t("placeholders.categoryNotFound", { category })}
            fillParentHeight
          />
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
            {categoryData.tokens.map((token) => (
              <TokenCard key={token.name} token={token} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
