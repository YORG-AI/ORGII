/**
 * SkillFrontmatterPanel
 *
 * Shown at the top of SKILL.md preview. Parses the YAML frontmatter block,
 * renders it as an editable "Properties" panel matching Cursor's native UI,
 * and serializes changes back into the full file content via onContentChange.
 */
import React, { useEffect, useRef, useState } from "react";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Switch from "@src/components/Switch";
import Textarea from "@src/components/Textarea";
import { Add01Icon, Cancel01Icon, HugeiconsIcon, Tick01Icon } from "@src/icons";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { CollapsibleSection } from "@src/modules/shared/layouts/blocks";

import {
  type SkillFrontmatter,
  formatSkillFrontmatterPropertyLabel,
  serializeFrontmatter,
} from "./skillFrontmatter";

export { parseSkillFrontmatter } from "./skillFrontmatter";
export type { ParseResult, SkillFrontmatter } from "./skillFrontmatter";

const PROPERTY_VALUE_CONTROL_STYLE: React.CSSProperties = {
  width: 400,
  maxWidth: "100%",
};
const PROPERTY_AUTOSAVE_DELAY_MS = 350;

// ── Property row ─────────────────────────────────────────────────────────────

interface PropertyRowProps {
  propKey: string;
  value: unknown;
  readOnly: boolean;
  onValueChange: (key: string, newValue: unknown) => void;
}

function PropertyRow({
  propKey,
  value,
  readOnly,
  onValueChange,
}: PropertyRowProps) {
  const isBool = typeof value === "boolean";
  const isObject =
    typeof value === "object" && value !== null && !Array.isArray(value);
  const displayValue = isObject ? JSON.stringify(value) : String(value ?? "");
  const [draftValue, setDraftValue] = useState(displayValue);
  const isLong = draftValue.length > 80 || draftValue.includes("\n");
  const rowAlign = isLong ? "start" : "center";
  const controlAlignClass = isLong ? "items-start" : "items-center";
  const propertyLabel = formatSkillFrontmatterPropertyLabel(propKey);

  useEffect(() => {
    setDraftValue(displayValue);
  }, [displayValue]);

  useEffect(() => {
    if (isBool || isObject || draftValue === displayValue) return;

    const autosaveTimeout = window.setTimeout(() => {
      onValueChange(propKey, draftValue);
    }, PROPERTY_AUTOSAVE_DELAY_MS);

    return () => window.clearTimeout(autosaveTimeout);
  }, [displayValue, draftValue, isBool, isObject, onValueChange, propKey]);

  function commitDraftValue() {
    if (!isBool && !isObject && draftValue !== displayValue) {
      onValueChange(propKey, draftValue);
    }
  }

  function handleTextKeyDown(
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>
  ) {
    if (event.key === "Enter" && !isLong) {
      commitDraftValue();
    }
  }

  return (
    <SectionRow
      label={propertyLabel}
      compact
      align={rowAlign}
      labelAlign={rowAlign}
      truncateLabel
      className="border-b border-border-2 last:border-0"
    >
      <div
        className={`flex w-full min-w-0 ${controlAlignClass} gap-2 @[480px]:justify-end`}
      >
        {isBool ? (
          <Switch
            checked={value as boolean}
            disabled={readOnly}
            size="default"
            onCheckedChange={(checked) => onValueChange(propKey, checked)}
            ariaLabel={propertyLabel}
          />
        ) : isLong ? (
          <Textarea
            value={draftValue}
            size="default"
            rows={Math.min(6, Math.max(1, draftValue.split("\n").length))}
            resize="vertical"
            autoSize={{ minRows: 1, maxRows: 6 }}
            disabled={readOnly || isObject}
            onChange={(newValue) => setDraftValue(newValue)}
            onBlur={commitDraftValue}
            onKeyDown={handleTextKeyDown}
            style={PROPERTY_VALUE_CONTROL_STYLE}
          />
        ) : (
          <Input
            value={draftValue}
            size="small"
            disabled={readOnly || isObject}
            onChange={(newValue) => setDraftValue(newValue)}
            onBlur={commitDraftValue}
            onKeyDown={handleTextKeyDown}
            style={PROPERTY_VALUE_CONTROL_STYLE}
          />
        )}
      </div>
    </SectionRow>
  );
}

// ── Add property row ─────────────────────────────────────────────────────────

interface AddPropertyRowProps {
  onAdd: (key: string, value: string) => void;
}

function AddPropertyRow({ onAdd }: AddPropertyRowProps) {
  const [active, setActive] = useState(false);
  const [key, setKey] = useState("");
  const [val, setVal] = useState("");
  const keyRef = useRef<HTMLInputElement>(null);
  const hasDraftChange = key.trim().length > 0 || val.length > 0;

  useEffect(() => {
    if (active) keyRef.current?.focus();
  }, [active]);

  function handleCommit() {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      setActive(false);
      setKey("");
      setVal("");
      return;
    }
    onAdd(trimmedKey, val);
    setActive(false);
    setKey("");
    setVal("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleCommit();
    if (e.key === "Escape") {
      setActive(false);
      setKey("");
      setVal("");
    }
  }

  function handleCancel() {
    setActive(false);
    setKey("");
    setVal("");
  }

  if (!active) {
    return (
      <SectionRow showHeader={false} compact>
        <Button
          variant="tertiary"
          size="small"
          icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />}
          onClick={() => setActive(true)}
          className="w-full justify-start"
        >
          Add property
        </Button>
      </SectionRow>
    );
  }

  return (
    <>
      <SectionRow
        label="New property"
        compact
        align="center"
        labelAlign="center"
        truncateLabel
        className="border-b border-border-2"
      >
        <div className="flex w-full min-w-0 items-center gap-2 @[480px]:justify-end">
          <Input
            ref={keyRef}
            placeholder="property name"
            value={key}
            size="small"
            onChange={(val) => setKey(val)}
            onKeyDown={handleKeyDown}
            className="w-[160px] shrink-0"
          />
          <Input
            placeholder="value"
            value={val}
            size="small"
            onChange={(newVal) => setVal(newVal)}
            onKeyDown={handleKeyDown}
            style={PROPERTY_VALUE_CONTROL_STYLE}
          />
        </div>
      </SectionRow>
      {hasDraftChange && (
        <SectionRow
          label="New properties"
          compact
          align="center"
          labelAlign="center"
        >
          <div className="flex w-full justify-end gap-2">
            <Button
              variant="secondary"
              size="small"
              icon={
                <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={14} />
              }
              iconOnly
              aria-label="Cancel new property"
              onClick={handleCancel}
              className="shrink-0"
            />
            <Button
              variant="primary"
              size="small"
              icon={
                <HugeiconsIcon icon={Tick01Icon} data-icon="check" size={14} />
              }
              iconOnly
              aria-label="Save new property"
              onClick={handleCommit}
              className="shrink-0"
            />
          </div>
        </SectionRow>
      )}
    </>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────

interface SkillFrontmatterPanelProps {
  frontmatter: SkillFrontmatter;
  body: string;
  readOnly?: boolean;
  onContentChange?: (newFullContent: string) => void;
}

const SkillFrontmatterPanel: React.FC<SkillFrontmatterPanelProps> = ({
  frontmatter,
  body,
  readOnly = false,
  onContentChange,
}) => {
  const [localFm, setLocalFm] = useState<SkillFrontmatter>(frontmatter);

  useEffect(() => {
    setLocalFm(frontmatter);
  }, [frontmatter]);

  function applyChange(updated: SkillFrontmatter) {
    setLocalFm(updated);
    onContentChange?.(serializeFrontmatter(updated, body));
  }

  function handleValueChange(key: string, newValue: unknown) {
    applyChange({ ...localFm, [key]: newValue });
  }

  function handleAdd(key: string, value: string) {
    applyChange({ ...localFm, [key]: value });
  }

  const entries = Object.entries(localFm).filter(
    ([, v]) => v !== undefined && v !== null
  );

  if (entries.length === 0 && readOnly) return null;

  return (
    <div className="pb-10">
      <CollapsibleSection title="Properties" defaultOpen compact>
        <SectionContainer>
          {entries.map(([key, value]) => (
            <PropertyRow
              key={key}
              propKey={key}
              value={value}
              readOnly={readOnly}
              onValueChange={handleValueChange}
            />
          ))}

          {!readOnly && <AddPropertyRow onAdd={handleAdd} />}
        </SectionContainer>
      </CollapsibleSection>
    </div>
  );
};

export default SkillFrontmatterPanel;
