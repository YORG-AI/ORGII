/**
 * TagsInput
 *
 * Multi-tag text input. Users type into a single-line `Input` and press
 * Enter or comma to commit the current draft as a tag. Backspace on an
 * empty input pops the last tag. Each tag is rendered as a 32px tall
 * pill (`rounded-full`) with a close (×) affordance.
 *
 * The chip background matches the input field background (`bg-bg-2`)
 * so tags read as a "row of inline values" inside the same surface as
 * the input itself.
 *
 * Controlled-only. Caller owns the `value` array and receives changes
 * via `onChange`. Duplicate tags are silently ignored.
 */
import React, { useCallback, useState } from "react";

import Input from "@src/components/Input";
import { Cancel01Icon, HugeiconsIcon } from "@src/icons";

export interface TagsInputProps {
  /** Current list of committed tags */
  value: string[];
  /** Called whenever the tag list changes (add / remove / pop) */
  onChange: (next: string[]) => void;
  /** Placeholder shown inside the text input */
  placeholder?: string;
  /**
   * Optional aria-label generator for the close button of each tag.
   * Receives the tag value so callers can localize with the tag name
   * (e.g. `(role) => t("removeRole", { role })`).
   */
  removeAriaLabel?: (tag: string) => string;
  /** Disable input + remove buttons */
  disabled?: boolean;
  /** Optional test-id prefix; chips get `${dataTestId}-chip-${i}` */
  dataTestId?: string;
}

const TagsInput: React.FC<TagsInputProps> = ({
  value,
  onChange,
  placeholder,
  removeAriaLabel,
  disabled = false,
  dataTestId,
}) => {
  const [draft, setDraft] = useState("");

  const commitDraft = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (value.includes(trimmed)) {
      setDraft("");
      return;
    }
    onChange([...value, trimmed]);
    setDraft("");
  }, [draft, value, onChange]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        commitDraft();
        return;
      }
      if (event.key === "Backspace" && draft.length === 0 && value.length > 0) {
        onChange(value.slice(0, -1));
      }
    },
    [commitDraft, draft, value, onChange]
  );

  const handleRemove = useCallback(
    (tag: string) => {
      onChange(value.filter((item) => item !== tag));
    },
    [onChange, value]
  );

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag, index) => (
            <span
              key={tag}
              data-testid={
                dataTestId ? `${dataTestId}-chip-${index}` : undefined
              }
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border-2 bg-bg-2 pl-3 pr-2 text-[12px] text-text-1"
            >
              <span className="leading-none">{tag}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => handleRemove(tag)}
                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={removeAriaLabel?.(tag) ?? `Remove ${tag}`}
              >
                <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={draft}
        onChange={setDraft}
        onKeyDown={handleKeyDown}
        onBlur={commitDraft}
        placeholder={placeholder}
        disabled={disabled}
      />
    </div>
  );
};

export default TagsInput;
