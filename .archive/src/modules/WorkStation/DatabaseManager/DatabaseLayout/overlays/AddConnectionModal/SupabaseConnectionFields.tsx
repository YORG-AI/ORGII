import { memo } from "react";
import { useTranslation } from "react-i18next";

import { AddConnectionFormField } from "./AddConnectionFormField";

export interface SupabaseConnectionFieldsProps {
  supabaseUrl: string;
  supabaseAccessToken: string;
  onSupabaseUrlChange: (value: string) => void;
  onSupabaseAccessTokenChange: (value: string) => void;
}

export const SupabaseConnectionFields = memo(function SupabaseConnectionFields({
  supabaseUrl,
  supabaseAccessToken,
  onSupabaseUrlChange,
  onSupabaseAccessTokenChange,
}: SupabaseConnectionFieldsProps) {
  const { t } = useTranslation();

  return (
    <>
      <AddConnectionFormField
        className="mb-4"
        label={t("database.projectUrl")}
        value={supabaseUrl}
        onChange={onSupabaseUrlChange}
        placeholder="https://xxxxx.supabase.co"
        hint={t("database.supabaseHint")}
      />
      <AddConnectionFormField
        className="mb-4"
        label={t("database.accessToken")}
        type="password"
        value={supabaseAccessToken}
        onChange={onSupabaseAccessTokenChange}
        placeholder="sbp_xxx..."
        hint={
          <>
            {t("database.supabaseTokenHint")}{" "}
            <a
              href="https://supabase.com/dashboard/account/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-6 hover:underline"
            >
              supabase.com/dashboard/account/tokens
            </a>
          </>
        }
      />
    </>
  );
});
