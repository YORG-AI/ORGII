/**
 * Editor Appearance Subpage
 *
 * Dedicated subpage for code editor appearance settings:
 *  - Typography (font family, font size, line height, tab size)
 *  - Editor Features (line numbers, word wrap, minimap, indent guides, highlight active line)
 *
 * Uses SubpageLayout with anchor navigation (one anchor per group).
 */
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import { useAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import Input from "@src/components/Input";
import NumberInput from "@src/components/NumberInput";
import Select from "@src/components/Select";
import Switch from "@src/components/Switch";
import { buildSettingsPath } from "@src/config/mainAppPaths";
import SubpageLayout from "@src/modules/shared/layouts/SubpageLayout";
import {
  CODE_FONT_FAMILIES,
  type CodeFontFamily,
  type EditorFontSize,
  type EditorLineHeight,
  type EditorLineNumbers,
  type EditorTabSize,
  codeFontFamilyAtom,
  customCodeFontFamilyAtom,
  editorAutoSaveAtom,
  editorFontSizeAtom,
  editorHighlightActiveLineAtom,
  editorLineHeightAtom,
  editorLineNumbersAtom,
  editorShowMinimapAtom,
  editorShowTreeIndentGuidesAtom,
  editorTabSizeAtom,
  editorWordWrapAtom,
} from "@src/store/ui/editorSettingsAtom";
import { terminalFontSizeAtom } from "@src/store/ui/uiAtom";

const CUSTOM_FONT_DEBOUNCE_MS = 3000;

// ============================================
// Theme & Typography Section
// ============================================

export const TypographySection: React.FC<{ showTitle?: boolean }> = ({
  showTitle = true,
}) => {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");

  const [codeFontFamily, setCodeFontFamily] = useAtom(codeFontFamilyAtom);
  const [customFontFamily, setCustomFontFamily] = useAtom(
    customCodeFontFamilyAtom
  );
  const [fontSize, setFontSize] = useAtom(editorFontSizeAtom);
  const [tabSize, setTabSize] = useAtom(editorTabSizeAtom);
  const [lineHeight, setLineHeight] = useAtom(editorLineHeightAtom);
  // Local state for custom font name with debounce
  const [localCustomFont, setLocalCustomFont] = useState(customFontFamily);
  const customFontDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  useEffect(() => {
    setLocalCustomFont(customFontFamily);
  }, [customFontFamily]);

  useEffect(() => {
    if (localCustomFont === customFontFamily) return;

    if (customFontDebounceRef.current) {
      clearTimeout(customFontDebounceRef.current);
    }

    customFontDebounceRef.current = setTimeout(() => {
      setCustomFontFamily(localCustomFont);
    }, CUSTOM_FONT_DEBOUNCE_MS);

    return () => {
      if (customFontDebounceRef.current) {
        clearTimeout(customFontDebounceRef.current);
      }
    };
  }, [localCustomFont, customFontFamily, setCustomFontFamily]);

  const handleFontFamilyChange = useCallback(
    (value: string | number | (string | number)[]) => {
      const fontValue = typeof value === "string" ? value : String(value);
      setCodeFontFamily(fontValue as CodeFontFamily);
    },
    [setCodeFontFamily]
  );

  return (
    <SectionContainer
      title={showTitle ? t("editor.themeTypography") : undefined}
    >
      <SectionRow label={t("editor.fontFamily")}>
        <Select
          value={codeFontFamily}
          onChange={handleFontFamilyChange}
          options={CODE_FONT_FAMILIES.map((f) => {
            if (f.value === "system") {
              return { value: f.value, label: t("editor.fontFamilySystem") };
            }
            if (f.value === "custom") {
              return { value: f.value, label: t("editor.fontFamilyCustom") };
            }
            return f;
          })}
          showSearch
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>

      {codeFontFamily === "custom" && (
        <SectionRow label={t("editor.customFontName")} indent>
          <Input
            value={localCustomFont}
            onChange={setLocalCustomFont}
            placeholder="Fira Code"
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
      )}

      <SectionRow label={t("editor.fontSize")}>
        <NumberInput
          value={fontSize}
          min={10}
          max={24}
          step={1}
          suffix={tCommon("common.px")}
          controlsPosition="sides"
          onValueChange={(value) =>
            setFontSize((value ?? 13) as EditorFontSize)
          }
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>

      <SectionRow label={t("editor.lineHeight")}>
        <NumberInput
          value={lineHeight}
          min={1.2}
          max={2.0}
          step={0.1}
          suffix={tCommon("common.multiplier")}
          controlsPosition="sides"
          onValueChange={(value) =>
            setLineHeight((value ?? 1.5) as EditorLineHeight)
          }
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>

      <SectionRow label={t("editor.tabSize")}>
        <NumberInput
          value={tabSize}
          min={2}
          max={8}
          step={2}
          suffix={tCommon("common.spaces")}
          controlsPosition="sides"
          onValueChange={(value) => setTabSize((value ?? 2) as EditorTabSize)}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
    </SectionContainer>
  );
};

// ============================================
// Terminal Section
// ============================================

export const TerminalSection: React.FC = () => {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const [terminalFontSize, setTerminalFontSize] = useAtom(terminalFontSizeAtom);

  return (
    <SectionContainer title={t("common:tabs.terminal")}>
      <SectionRow label={t("editor.terminalFontSize")}>
        <NumberInput
          value={terminalFontSize}
          min={8}
          max={32}
          step={1}
          suffix={tCommon("common.px")}
          controlsPosition="sides"
          onValueChange={(value) => setTerminalFontSize(value ?? 13)}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
    </SectionContainer>
  );
};

// ============================================
// Editor Section (tree view + editor features)
// ============================================

export const FeaturesSection: React.FC = () => {
  const { t } = useTranslation("settings");

  const [showTreeIndentGuides, setShowTreeIndentGuides] = useAtom(
    editorShowTreeIndentGuidesAtom
  );
  const [lineNumbers, setLineNumbers] = useAtom(editorLineNumbersAtom);
  const [wordWrap, setWordWrap] = useAtom(editorWordWrapAtom);
  const [autoSave, setAutoSave] = useAtom(editorAutoSaveAtom);
  const [showMinimap, setShowMinimap] = useAtom(editorShowMinimapAtom);
  const [highlightActiveLine, setHighlightActiveLine] = useAtom(
    editorHighlightActiveLineAtom
  );

  const handleLineNumbersChange = useCallback(
    (value: string | number | (string | number)[]) => {
      const mode = typeof value === "string" ? value : String(value);
      setLineNumbers(mode as EditorLineNumbers);
    },
    [setLineNumbers]
  );

  const lineNumbersOptions = useMemo(
    () => [
      { value: "on", label: t("common:common.on") },
      { value: "off", label: t("common:common.off") },
      { value: "relative", label: t("editor.lineNumbersRelative") },
      { value: "interval", label: t("editor.lineNumbersInterval") },
    ],
    [t]
  );

  return (
    <SectionContainer title={t("editor.tabEditor")}>
      <SectionRow label={t("editor.treeIndentGuides")}>
        <Switch
          checked={showTreeIndentGuides}
          onCheckedChange={setShowTreeIndentGuides}
        />
      </SectionRow>

      <SectionRow label={t("editor.lineNumbers")}>
        <Select
          value={lineNumbers}
          onChange={handleLineNumbersChange}
          options={lineNumbersOptions}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>

      <SectionRow label={t("editor.wordWrap")}>
        <Switch checked={wordWrap} onCheckedChange={setWordWrap} />
      </SectionRow>

      <SectionRow label={t("editor.autoSave")}>
        <Switch checked={autoSave} onCheckedChange={setAutoSave} />
      </SectionRow>

      <SectionRow label={t("editor.minimap")}>
        <Switch checked={showMinimap} onCheckedChange={setShowMinimap} />
      </SectionRow>

      <SectionRow label={t("editor.highlightActiveLine")}>
        <Switch
          checked={highlightActiveLine}
          onCheckedChange={setHighlightActiveLine}
        />
      </SectionRow>
    </SectionContainer>
  );
};

// ============================================
// Page Component
// ============================================

const EditorAppearancePage: React.FC = () => {
  const { t } = useTranslation("settings");
  const navigate = useNavigate();

  const handleBack = useCallback(() => {
    navigate(buildSettingsPath({ section: "appearance" }));
  }, [navigate]);

  return (
    <SubpageLayout
      onBack={handleBack}
      breadcrumb={{
        parent: t("common:tabs.settings"),
        current: t("editor.codeEditorAppearanceTitle"),
      }}
    >
      <TypographySection />
      <TerminalSection />
      <FeaturesSection />
    </SubpageLayout>
  );
};

export default EditorAppearancePage;
