"""Reduce extracted Codex theme chunks to skin seeds.

Applies Codex's own rules for picking `surface`, `ink`, `accent`, and the
semantic diff/skill hues out of a VS Code theme, then merges any explicit
`chromeTheme` the theme declares. Run `extractCodexThemes.py` first.

    python3 scripts/appearance/deriveCodexSeeds.py

Writes `scripts/appearance/codex_seeds.json`, which `emitCodexSkins.py` turns
into the checked-in TypeScript registry.
"""

import json, os, re, math, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TDIR = os.path.join(HERE, "themes")

REGISTRY = {
  "ayu":         {"label":"Ayu",        "dark":"ayu-dark-CeqGgIUP.js"},
  "catppuccin":  {"label":"Catppuccin", "dark":"catppuccin-mocha-dHoV60mf.js", "light":"catppuccin-latte-BZJoddiB.js"},
  "absolutely":  {"label":"Absolutely", "dark":"absolutely-dark-DF-mdRUO.js",  "light":"absolutely-light-ea768yt2.js"},
  "codex":       {"label":"Codex",      "dark":"codex-dark-D6Chcqxh.js",       "light":"codex-light-CEcYz7se.js"},
  "dracula":     {"label":"Dracula",    "dark":"dracula-RIiGWNqC.js"},
  "everforest":  {"label":"Everforest", "dark":"everforest-dark-DmkgEkzz.js",  "light":"everforest-light-T34-7ou5.js"},
  "github":      {"label":"GitHub",     "dark":"github-dark-default-rleDmZWP.js","light":"github-light-default-Dk6Lh17z.js"},
  "gruvbox":     {"label":"Gruvbox",    "dark":"gruvbox-dark-medium-Cf4wLTts.js","light":"gruvbox-light-medium-B3fSII4q.js"},
  "linear":      {"label":"Linear",     "dark":"linear-dark-BRQX7y-Q.js",      "light":"linear-light-Ney_5gwq.js"},
  "lobster":     {"label":"Lobster",    "dark":"lobster-dark-CVBhLl1c.js"},
  "material":    {"label":"Material",   "dark":"material-theme-darker-Bc-XbEnm.js"},
  "matrix":      {"label":"Matrix",     "dark":"matrix-dark-GrrTW5Oo.js"},
  "monokai":     {"label":"Monokai",    "dark":"monokai-b2iUZx-f.js"},
  "night-owl":   {"label":"Night Owl",  "dark":"night-owl-pZxW_mxe.js"},
  "nord":        {"label":"Nord",       "dark":"nord-CrGFdBne.js"},
  "notion":      {"label":"Notion",     "dark":"notion-dark-BmllqXIm.js",      "light":"notion-light-CFL6wrp4.js"},
  "oscurange":   {"label":"Oscurange",  "dark":"oscurange-DaN-xPFd.js"},
  "one":         {"label":"One",        "dark":"one-dark-pro-ChZMsqhY.js",     "light":"one-light-Dxr2ofMB.js"},
  "proof":       {"label":"Proof",                                             "light":"proof-light-D9Z3ALX4.js"},
  "raycast":     {"label":"Raycast",    "dark":"raycast-dark-BW46zYz_.js",     "light":"raycast-light-BfrsPS9K.js"},
  "rose-pine":   {"label":"Rose Pine",  "dark":"rose-pine-moon-DtTX1wc3.js",   "light":"rose-pine-dawn-CQWqf0Lw.js"},
  "sentry":      {"label":"Sentry",     "dark":"sentry-dark-niAx59sA.js"},
  "solarized":   {"label":"Solarized",  "dark":"solarized-dark-ydLaWs6T.js",   "light":"solarized-light-B7zgh9sP.js"},
  "tokyo-night": {"label":"Tokyo Night","dark":"tokyo-night-XKHMSU-n.js"},
  "temple":      {"label":"Temple",     "dark":"temple-dark-DVhaAhwN.js"},
  "vercel":      {"label":"Vercel",     "dark":"vercel-dark-DyYjYzAP.js",      "light":"vercel-light-CHh12R5u.js"},
  "vscode-plus": {"label":"VS Code Plus","dark":"dark-plus-CnTX8WLE.js",       "light":"light-plus-CZYDAulh.js"},
  "xcode":       {"label":"Xcode",      "dark":"xcode-dark-Bp_RF4xS.js",       "light":"xcode-light-T2wmffeX.js"},
}

SURFACE_KEYS = ["editor.background","sideBar.background","editorGroupHeader.tabsBackground","panel.background","activityBar.background"]
INK_KEYS     = ["editor.foreground","sideBarTitle.foreground","sideBar.foreground","foreground"]
ACCENT_KEYS  = ["activityBarBadge.background","textLink.foreground","editorCursor.foreground","focusBorder","button.background","activityBar.activeBorder"]
ADDED_KEYS   = ["gitDecoration.addedResourceForeground","gitDecoration.untrackedResourceForeground","terminal.ansiGreen","terminal.ansiBrightGreen"]
REMOVED_KEYS = ["gitDecoration.deletedResourceForeground","terminal.ansiRed","terminal.ansiBrightRed"]
SKILL_KEYS   = ["charts.purple","terminal.ansiMagenta","terminal.ansiBrightMagenta"]

MIN_ALPHA, MIN_CHROMA = 0.45, 24
ADDED_HUE, ADDED_TARGET     = (80,170), 125
REMOVED_HUE, REMOVED_TARGET = (345,15), 0
SKILL_HUE, SKILL_TARGET     = (210,320), 265

DEFAULTS = {
 "light": {"accent":"#3a83f7","contrast":45,"ink":"#0d0d0d","opaqueWindows":True,
           "semanticColors":{"diffAdded":"#00a240","diffRemoved":"#ba2623","skill":"#924ff7"},"surface":"#fcfcfc"},
 "dark":  {"accent":"#3a83f7","contrast":60,"ink":"#ffffff","opaqueWindows":True,
           "semanticColors":{"diffAdded":"#40c977","diffRemoved":"#fa423e","skill":"#ad7bf9"},"surface":"#000000"},
}

def parse_hex(v):
    if not isinstance(v,str): return None
    t=v.strip()
    if not re.fullmatch(r"#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", t): return None
    a = int(t[7:9],16)/255 if len(t)==9 else 1.0
    return {"r":int(t[1:3],16),"g":int(t[3:5],16),"b":int(t[5:7],16),"a":a}

def to_hex(c): return "#%02x%02x%02x" % (c["r"],c["g"],c["b"])
def chroma(c): return max(c["r"],c["g"],c["b"]) - min(c["r"],c["g"],c["b"])
def dist(a,b): return math.sqrt((a["r"]-b["r"])**2 + (a["g"]-b["g"])**2 + (a["b"]-b["b"])**2)
def too_close(x,y):
    a,b = parse_hex(x), parse_hex(y)
    return False if (a is None or b is None) else dist(a,b) < 42
def score(x,s,i):
    c,cs,ci = parse_hex(x), parse_hex(s), parse_hex(i)
    if not (c and cs and ci): return 0
    return chroma(c) + dist(c,cs)/4 + dist(c,ci)/4
def hue(c):
    r,g,b = c["r"]/255, c["g"]/255, c["b"]/255
    mx = max(r,g,b); d = mx - min(r,g,b)
    if d == 0: return None
    if mx == r: h = ((g-b)/d % 6)*60
    elif mx == g: h = ((b-r)/d + 2)*60
    else: h = ((r-g)/d + 4)*60
    return (h+360) % 360
def in_range(h,rng):
    lo,hi = rng
    return (lo <= h <= hi) if lo <= hi else (h >= lo or h <= hi)
def hue_dist(h,t):
    n = abs(h-t); return min(n, 360-n)
def pick(colors, keys, min_alpha=0.98, min_chroma=0):
    if not colors: return None
    for k in keys:
        c = parse_hex(colors.get(k))
        if c and c["a"] >= min_alpha and chroma(c) >= min_chroma: return to_hex(c)
    return None

# ---- JS chunk parsing -------------------------------------------------------
def read_chunk(path):
    src = open(path, encoding="utf8").read()
    # Shiki bundles ship as Object.freeze(JSON.parse(`{...}`)) — one JSON blob.
    m = re.search(r"JSON\.parse\(`(.*?)`\)", src, re.S)
    if m:
        return json.loads(m.group(1))
    exp = re.search(r"export\{([^}]*)\}", src)
    alias = {}
    if exp:
        for part in exp.group(1).split(","):
            m = re.match(r"\s*(\w+)\s+as\s+([\w$]+)\s*$", part)
            if m: alias[m.group(2)] = m.group(1)
    out = {}
    for want in ("colors","tokenColors","semanticTokenColors","settings","chromeTheme","type","name"):
        var = alias.get(want)
        if not var: continue
        m = re.search(r"(?:^|[,;{(])" + re.escape(var) + r"\s*=\s*([\[{`])", src)
        if not m: continue
        start = m.start(1)
        if src[start] == "`":
            end = src.index("`", start+1); out[want] = src[start+1:end]; continue
        out[want] = js_literal(src, start)
    return out

def js_literal(src, start):
    """Balance brackets from `start`, then convert the JS literal to JSON."""
    open_c = src[start]; close_c = "}" if open_c == "{" else "]"
    depth = 0; i = start; in_s = None
    while i < len(src):
        ch = src[i]
        if in_s:
            if ch == "\\": i += 2; continue
            if ch == in_s: in_s = None
        elif ch in "`'\"": in_s = ch
        elif ch == open_c: depth += 1
        elif ch == close_c:
            depth -= 1
            if depth == 0: break
        i += 1
    raw = src[start:i+1]
    raw = re.sub(r"`([^`\\]*)`", lambda m: json.dumps(m.group(1)), raw)
    raw = re.sub(r"'([^'\\]*)'", lambda m: json.dumps(m.group(1)), raw)
    raw = re.sub(r"([{,])\s*([A-Za-z_$][\w$.\-]*)\s*:", lambda m: '%s"%s":' % (m.group(1), m.group(2)), raw)
    raw = re.sub(r",\s*([}\]])", r"\1", raw)
    raw = re.sub(r"(?<![\w$])!0(?![\w$])", "true", raw)
    raw = re.sub(r"(?<![\w$])!1(?![\w$])", "false", raw)
    return json.loads(raw)

# ---- Codex seed derivation --------------------------------------------------
def all_color_values(theme):
    return [v for v in (theme.get("colors") or {}).values() if isinstance(v,str)]

def token_entries(theme):
    """Codex reads [...tokenColors, ...settings] — partner themes use `settings`."""
    return list(theme.get("tokenColors") or []) + list(theme.get("settings") or [])

def scan_semantic(theme, surface, ink, hue_rng, hue_target):
    best, best_score = None, -1
    for v in all_color_values(theme):
        if too_close(v,surface) or too_close(v,ink): continue
        c = parse_hex(v)
        if not c: continue
        h = hue(c)
        if h is None or not in_range(h,hue_rng): continue
        s = score(v,surface,ink) - hue_dist(h,hue_target)*2
        if s > best_score: best, best_score = to_hex(c), s
    return best

def derive_accent(theme, surface, ink):
    a = None
    colors = theme.get("colors") or {}
    for k in ACCENT_KEYS:
        c = parse_hex(colors.get(k))
        if c and c["a"] >= MIN_ALPHA and chroma(c) >= MIN_CHROMA:
            hx = to_hex(c)
            if not too_close(hx,surface) and not too_close(hx,ink): return hx
    best, best_score = None, -1
    for e in token_entries(theme):
        fg = (e.get("settings") or {}).get("foreground")
        c = parse_hex(fg)
        if not c or c["a"] < MIN_ALPHA or chroma(c) < MIN_CHROMA: continue
        hx = to_hex(c)
        if too_close(hx,surface) or too_close(hx,ink): continue
        s = score(hx,surface,ink)
        if s > best_score: best, best_score = hx, s
    return best

def derive_seed(theme, variant):
    d = DEFAULTS[variant]
    colors = theme.get("colors") or {}
    surface = pick(colors, SURFACE_KEYS) or d["surface"]
    ink     = pick(colors, INK_KEYS)     or d["ink"]
    accent  = derive_accent(theme, surface, ink) or d["accent"]
    sem = {
      "diffAdded":   pick(colors,ADDED_KEYS)   or scan_semantic(theme,surface,ink,ADDED_HUE,ADDED_TARGET)     or d["semanticColors"]["diffAdded"],
      "diffRemoved": pick(colors,REMOVED_KEYS) or scan_semantic(theme,surface,ink,REMOVED_HUE,REMOVED_TARGET) or d["semanticColors"]["diffRemoved"],
      "skill":       pick(colors,SKILL_KEYS)   or scan_semantic(theme,surface,ink,SKILL_HUE,SKILL_TARGET)
                     or (accent if (not too_close(accent,surface) and not too_close(accent,ink)) else d["semanticColors"]["skill"]),
    }
    seed = {"surface":surface,"ink":ink,"accent":accent,"contrast":d["contrast"],
            "opaqueWindows":d["opaqueWindows"],"semanticColors":sem}
    # Partner themes ship an explicit chromeTheme that overrides the derived seed.
    override = theme.get("chromeTheme")
    if isinstance(override, dict):
        sem2 = {**seed["semanticColors"], **(override.get("semanticColors") or {})}
        seed = {**seed, **{k:v for k,v in override.items() if k != "semanticColors"}}
        seed["semanticColors"] = {k: v.lower() for k, v in sem2.items()}
        seed["surface"] = seed["surface"].lower(); seed["ink"] = seed["ink"].lower()
        seed["accent"] = seed["accent"].lower()
    return seed

# ---- syntax palette from tokenColors ---------------------------------------
SCOPE_MAP = {
  "comment":   ["comment","punctuation.definition.comment"],
  "string":    ["string","string.quoted","string.quoted.double"],
  "keyword":   ["keyword","keyword.control","storage.type","storage.modifier"],
  "function":  ["entity.name.function","support.function","variable.function","meta.function-call"],
  "variable":  ["variable","variable.other","variable.parameter"],
  "number":    ["constant.numeric","constant.numeric.integer"],
  "operator":  ["keyword.operator"],
  "tag":       ["entity.name.tag"],
  "attribute": ["entity.other.attribute-name"],
  "property":  ["support.type.property-name","variable.other.property","meta.object-literal.key"],
  "type":      ["entity.name.type","support.type","support.class","entity.name.class"],
  "constant":  ["constant.language","constant.other","support.constant"],
  "invalid":   ["invalid","invalid.illegal"],
}

def scope_list(entry):
    s = entry.get("scope")
    if s is None: return []
    return [x.strip() for x in s.split(",")] if isinstance(s,str) else [str(x).strip() for x in s]

def derive_syntax(theme):
    """Pick one representative color per category.

    VS Code resolves the *most specific* scope for a given token, but here we
    want the most *canonical* one for a whole category, so scoring is inverted:
    an exact scope beats a longer descendant of it. Contextual selectors (those
    containing a space, e.g. `constant.numeric.line-number - match`) are skipped
    outright — they describe one UI situation, not the language token.
    """
    entries = token_entries(theme)
    out = {}
    for name, wanted in SCOPE_MAP.items():
        best, best_rank = None, None
        for e in entries:
            fg = (e.get("settings") or {}).get("foreground")
            c = parse_hex(fg)
            if not c: continue
            for sc in scope_list(e):
                if not sc or " " in sc: continue
                for pref, w in enumerate(wanted):
                    if sc == w:
                        rank = (0, 0, pref)
                    elif sc.startswith(w + "."):
                        rank = (1, sc.count(".") - w.count("."), pref)
                    elif w.startswith(sc + "."):
                        rank = (2, w.count(".") - sc.count("."), pref)
                    else:
                        continue
                    if best_rank is None or rank < best_rank:
                        best, best_rank = to_hex(c), rank
        if best: out[name] = best
    return out

result = {}
for tid, meta in REGISTRY.items():
    entry = {"label": meta["label"], "variants": {}}
    for variant in ("light","dark"):
        fn = meta.get(variant)
        if not fn: continue
        path = os.path.join(TDIR, fn)
        if not os.path.exists(path):
            print("MISSING", fn, file=sys.stderr); continue
        theme = read_chunk(path)
        seed = derive_seed(theme, variant)
        seed["syntax"] = derive_syntax(theme)
        seed["sourceName"] = theme.get("name")
        entry["variants"][variant] = seed
    result[tid] = entry

json.dump(result, open(os.path.join(HERE,"codex_seeds.json"),"w"), indent=2)
print("themes:", len(result))
for tid, e in result.items():
    for v, s in e["variants"].items():
        print(f'{tid:14s} {v:5s} surface={s["surface"]} ink={s["ink"]} accent={s["accent"]} add={s["semanticColors"]["diffAdded"]} del={s["semanticColors"]["diffRemoved"]} skill={s["semanticColors"]["skill"]} syn={len(s["syntax"])}')
