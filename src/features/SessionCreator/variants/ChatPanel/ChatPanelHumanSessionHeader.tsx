/**
 * SessionCreatorChatPanel — Human Session Title Header
 *
 * The composer-header title input shown when the panel is creating a Work
 * log (human session) entry. Extracted from SessionCreatorChatPanel to keep
 * the component file under the 600-line limit.
 */
import type { TFunction } from "i18next";
import React from "react";

import { HUMAN_SESSION_TITLE_MAX_LENGTH } from "@src/api/tauri/rpc/schemas/humanSession";
import Input from "@src/components/Input";
import { GHOST_INPUT_PLACEHOLDER_CLASS } from "@src/components/Input/tokens";

interface ChatPanelHumanSessionHeaderProps {
  humanTitle: string;
  setHumanTitle: (title: string) => void;
  humanCreating: boolean;
  t: TFunction<"sessions">;
}

const ChatPanelHumanSessionHeader: React.FC<
  ChatPanelHumanSessionHeaderProps
> = ({ humanTitle, setHumanTitle, humanCreating, t }) => (
  <div data-testid="create-human-session-header">
    <div className="flex h-10 items-center px-1 py-0">
      <Input
        type="text"
        value={humanTitle}
        onChange={setHumanTitle}
        placeholder={t("humanSession.titlePlaceholder")}
        maxLength={HUMAN_SESSION_TITLE_MAX_LENGTH}
        autoFocus
        disabled={humanCreating}
        fieldVariant="ghost"
        size="small"
        className="flex-1 focus-within:!bg-transparent hover:!bg-transparent"
        inputClassName={GHOST_INPUT_PLACEHOLDER_CLASS}
        data-testid="create-human-session-title-input"
      />
    </div>
    <div className="px-2" aria-hidden>
      <div className="border-t border-border-2" />
    </div>
  </div>
);

export default ChatPanelHumanSessionHeader;
