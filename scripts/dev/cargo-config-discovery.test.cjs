const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const rootConfig = path.join(repoRoot, ".cargo", "config.toml");
const nestedConfig = path.join(repoRoot, "src-tauri", ".cargo", "config.toml");

// Cargo resolves `.cargo/config.toml` by walking up from the *current working
// directory*, not from the package manifest. The Tauri CLI invokes cargo from
// the repo root, so a config that lives only under `src-tauri/` is read when a
// developer runs `cargo` by hand there and ignored for every `pnpm tauri:dev`
// build. That split is invisible - the build succeeds either way, it just
// silently drops settings - so it is asserted here rather than left to review.

test("the cargo config lives at the repo root so cwd cannot change it", () => {
  assert.ok(
    fs.existsSync(rootConfig),
    ".cargo/config.toml must exist at the repository root"
  );
});

test("no second cargo config shadows it from src-tauri", () => {
  assert.equal(
    fs.existsSync(nestedConfig),
    false,
    "src-tauri/.cargo/config.toml would apply only to cargo runs started " +
      "inside src-tauri/, silently diverging from the root config"
  );
});

test("incremental compilation stays disabled", () => {
  // Incremental sessions land in the shared target dir, which cargo-sweep does
  // not collect, and they race across concurrent cargo processes sharing that
  // dir. See the comment block at the top of .cargo/config.toml.
  const config = fs.readFileSync(rootConfig, "utf8");
  const setting = config
    .split("\n")
    .filter((line) => /^\s*incremental\s*=/.test(line))
    .pop();

  assert.ok(setting, "config must state an explicit `incremental` setting");
  assert.match(setting, /incremental\s*=\s*false/);
});

test("the parallelism cap survives the move", () => {
  // `jobs` bounds peak build memory on 16 GB machines; losing it to a cwd
  // change is the same class of silent failure as the incremental setting.
  const config = fs.readFileSync(rootConfig, "utf8");
  assert.match(config, /^\s*jobs\s*=\s*\d+/m);
});
