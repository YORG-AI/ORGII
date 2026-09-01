"""Emit `src/config/appearance/skins/codexSkins.ts` from derived Codex seeds.

Pipeline (all three steps are provenance tooling, not part of the app build):

    python3 scripts/appearance/extractCodexThemes.py   # ChatGPT.app/app.asar -> theme chunks
    python3 scripts/appearance/deriveCodexSeeds.py     # theme chunks       -> codex_seeds.json
    python3 scripts/appearance/emitCodexSkins.py       # codex_seeds.json   -> codexSkins.ts

Re-run only when adopting a newer Codex build. The emitted file is checked in so
the app never depends on a local Codex install.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SEEDS = os.environ.get("CODEX_SEEDS", os.path.join(HERE, "codex_seeds.json"))
TARGET = os.path.join(REPO, "src", "config", "appearance", "skins", "codexSkins.ts")

SYNTAX_ORDER = [
    "comment", "string", "keyword", "function", "variable", "number",
    "operator", "tag", "attribute", "property", "type", "constant", "invalid",
]

HEADER = '''/**
 * Codex app skins.
 *
 * Seeds are extracted from the Codex desktop app's bundled theme registry and
 * reduced with Codex's own rules: `surface` and `ink` come from the first
 * present `editor.background` / `editor.foreground` (falling back through the
 * sideBar and panel keys), `accent` from the first sufficiently chromatic
 * `activityBarBadge.background` / `textLink.foreground` /
 * `editorCursor.foreground`, and the semantic hues from the matching
 * `gitDecoration.*` and `terminal.ansi*` entries. Partner themes (Linear,
 * Notion, Vercel, Raycast, Sentry, Xcode) ship an explicit `chromeTheme` seed,
 * which overrides the derived values verbatim.
 *
 * Syntax colors are the canonical scope for each category, preferring an exact
 * TextMate scope over a longer descendant of it.
 *
 * DO NOT EDIT BY HAND. Regenerate with the scripts in `scripts/appearance/`.
 */
import type { SkinDefinition } from "./types";

export const CODEX_SKINS: readonly SkinDefinition[] = [
'''


def q(value):
    return json.dumps(value)


def main():
    if not os.path.exists(SEEDS):
        sys.exit(f"missing seeds file: {SEEDS} (run deriveCodexSeeds.py first)")
    data = json.load(open(SEEDS, encoding="utf8"))

    out = [HEADER]
    for theme_id, entry in data.items():
        out.append("  {\n")
        out.append(f"    id: {q('codex-' + theme_id)},\n")
        out.append(f"    label: {q(entry['label'])},\n")
        out.append('    source: "codex",\n')
        out.append("    variants: {\n")
        for variant in ("light", "dark"):
            seed = entry["variants"].get(variant)
            if not seed:
                continue
            out.append(f"      {variant}: {{\n")
            out.append("        seed: {\n")
            out.append(f"          surface: {q(seed['surface'])},\n")
            out.append(f"          ink: {q(seed['ink'])},\n")
            out.append(f"          accent: {q(seed['accent'])},\n")
            out.append(f"          contrast: {int(seed['contrast'])},\n")
            semantic = seed["semanticColors"]
            out.append("          semanticColors: {\n")
            for key in ("diffAdded", "diffRemoved", "skill"):
                out.append(f"            {key}: {q(semantic[key])},\n")
            out.append("          },\n")
            syntax = seed.get("syntax") or {}
            if syntax:
                out.append("          syntax: {\n")
                for key in SYNTAX_ORDER:
                    if key in syntax:
                        out.append(f"            {key}: {q(syntax[key])},\n")
                out.append("          },\n")
            else:
                out.append("          syntax: {},\n")
            out.append("        },\n")
            if seed.get("sourceName"):
                out.append(f"        sourceName: {q(seed['sourceName'])},\n")
            out.append("      },\n")
        out.append("    },\n")
        out.append("  },\n")
    out.append("];\n")

    open(TARGET, "w", encoding="utf8").write("".join(out))
    variants = sum(len(e["variants"]) for e in data.values())
    print(f"wrote {TARGET}: {len(data)} skins, {variants} variants")


if __name__ == "__main__":
    main()
