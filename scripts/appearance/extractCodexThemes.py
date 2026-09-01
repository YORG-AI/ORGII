"""Extract Codex's bundled theme chunks from the desktop app bundle.

The Codex desktop app ships inside ChatGPT.app. Its theme registry lives in
`app.asar` as lazily imported chunks — VS Code style theme JSON for the Shiki
themes, and hand-authored modules carrying an explicit `chromeTheme` seed for
the partner themes (Linear, Notion, Vercel, Raycast, Sentry, Xcode).

    python3 scripts/appearance/extractCodexThemes.py [path/to/app.asar]

Override the bundle path with the CODEX_ASAR environment variable or the first
argument. Output goes to `scripts/appearance/themes/`.
"""

import json, struct, os, sys, re

DEFAULT_ASAR = "/Applications/ChatGPT.app/Contents/Resources/app.asar"
ASAR = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.environ.get("CODEX_ASAR", DEFAULT_ASAR)
)
OUT=os.path.join(os.path.dirname(os.path.abspath(__file__)),"themes")
if not os.path.exists(ASAR):
    sys.exit(
        f"Codex bundle not found at {ASAR}.\n"
        "Install the ChatGPT desktop app, or pass the app.asar path as an argument."
    )
os.makedirs(OUT, exist_ok=True)
f=open(ASAR,'rb')
# asar pickle header: uint32 size-of-header-pickle(=4), uint32 header-json-pickle-size, uint32 header-string-size, uint32 header json len
hdr=f.read(16)
_, _, _, jlen = struct.unpack('<IIII', hdr)
header=json.loads(f.read(jlen).decode('utf8'))
base = 16 + jlen
base += (4 - base % 4) % 4

wanted_re = re.compile(r'^(ayu-dark|catppuccin-latte|catppuccin-mocha|dark-plus|dracula|everforest-dark|everforest-light|github-dark-default|github-light-default|gruvbox-dark-medium|gruvbox-light-medium|light-plus|material-theme-darker|monokai|night-owl|nord|one-dark-pro|one-light|rose-pine-dawn|rose-pine-moon|solarized-dark|solarized-light|tokyo-night|absolutely-dark|absolutely-light|codex-dark|codex-light|linear-dark|linear-light|lobster-dark|matrix-dark|notion-dark|notion-light|oscurange|proof-light|raycast-dark|raycast-light|sentry-dark|temple-dark|vercel-dark|vercel-light|xcode-dark|xcode-light)-[A-Za-z0-9_-]+\.js$')

found={}
def walk(node, path):
    for name, meta in node.get('files', {}).items():
        p = path + [name]
        if 'files' in meta:
            walk(meta, p)
        else:
            if wanted_re.match(name):
                found['/'.join(p)] = meta
walk(header, [])
print("matched files:", len(found))
for path, meta in sorted(found.items()):
    off = int(meta['offset']); size = int(meta['size'])
    f.seek(base + off)
    data = f.read(size)
    name = os.path.basename(path)
    open(os.path.join(OUT, name), 'wb').write(data)
print("written to", OUT)
