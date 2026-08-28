import React, { forwardRef, memo } from "react";

import SelectorPill from "@src/components/SelectorPill";
import { ArrowDown01Icon, HugeiconsIcon } from "@src/icons";

export interface SessionCreatorAgentHeroProps {
  name: string;
  description: string;
  avatarIcon: React.ReactNode;
  question?: string;
  questionSuffix?: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
}

const SessionCreatorAgentHero = memo(
  forwardRef<HTMLButtonElement, SessionCreatorAgentHeroProps>(
    (
      {
        name,
        description,
        avatarIcon,
        question,
        questionSuffix,
        active = false,
        danger = false,
        onClick,
      },
      ref
    ) => {
      if (question || questionSuffix) {
        return (
          <div className="session-creator-agent-hero-question flex w-full min-w-0 justify-center px-4 text-center">
            <div
              role="heading"
              aria-level={1}
              className="flex max-w-full flex-wrap items-center justify-center gap-1 whitespace-normal break-words text-[18px] font-normal leading-relaxed tracking-tight text-text-1 sm:text-[20px]"
            >
              {question && (
                <span className="hidden @[640px]/focusedchat:inline">
                  {question}
                </span>
              )}
              <SelectorPill
                ref={ref}
                icon={avatarIcon}
                label={name}
                labelContent={
                  <span className="whitespace-normal break-words">{name}</span>
                }
                active={active}
                activeTone="neutral"
                danger={danger}
                size="lg"
                appearance="bare"
                trailingChevron
                onClick={onClick}
                ariaLabel={name}
                ariaExpanded={active}
                dataTestId="session-creator-agent-selector"
                className="!flex !min-h-0 !bg-transparent !p-2 !text-[18px] !font-normal !leading-relaxed !tracking-tight !text-text-1 sm:!text-[20px]"
                labelClassName={`!whitespace-normal !break-words !text-[18px] !font-bold !leading-relaxed !tracking-tight sm:!text-[20px] ${
                  danger
                    ? "!text-primary-6"
                    : active
                      ? "!text-text-1 underline underline-offset-4"
                      : "!text-text-2 group-hover/pill:!text-text-1 group-hover/pill:underline group-hover/pill:underline-offset-4"
                }`}
                chevronClassName={`transition-colors ${
                  danger
                    ? "!text-primary-6"
                    : active
                      ? "!text-text-1"
                      : "!text-text-3 group-hover/pill:!text-text-1"
                }`}
              />
              {questionSuffix && (
                <span className="hidden @[640px]/focusedchat:inline">
                  {questionSuffix}
                </span>
              )}
            </div>
          </div>
        );
      }

      return (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          aria-expanded={active}
          data-testid="session-creator-agent-selector"
          className="flex w-full items-start gap-3 rounded-lg px-1 py-1 text-left transition-colors hover:bg-fill-2"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-fill-2">
            {avatarIcon}
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex min-w-0 items-center gap-1">
              <span
                className={`truncate text-[15px] font-semibold leading-tight ${
                  danger ? "text-primary-6" : "text-text-1"
                }`}
              >
                {name}
              </span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={14}
                strokeWidth={2}
                className={`shrink-0 text-text-3 transition-transform ${
                  active ? "rotate-180" : ""
                }`}
              />
            </div>
            <p
              className="mt-1 truncate text-[12px] leading-snug text-text-3"
              title={description}
            >
              {description}
            </p>
          </div>
        </button>
      );
    }
  )
);

SessionCreatorAgentHero.displayName = "SessionCreatorAgentHero";

export default SessionCreatorAgentHero;
