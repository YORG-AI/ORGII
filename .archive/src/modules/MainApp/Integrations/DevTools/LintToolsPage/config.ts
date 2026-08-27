/**
 * Configuration constants for Lint Tools Page
 */

export const LINT_TOOL_DOCS_URL: Record<string, string> = {
  eslint: "https://eslint.org/docs/latest/use/getting-started",
  prettier: "https://prettier.io/docs/en/install",
  stylelint: "https://stylelint.io/user-guide/get-started",
  biome: "https://biomejs.dev/guides/getting-started",
  tsc: "https://www.typescriptlang.org/docs",
  ruff: "https://docs.astral.sh/ruff",
  pylint: "https://pylint.readthedocs.io/en/stable",
  flake8: "https://flake8.pycqa.org/en/latest",
  mypy: "https://mypy.readthedocs.io/en/stable",
  black: "https://black.readthedocs.io/en/stable",
  "rust-analyzer": "https://rust-analyzer.github.io",
  clippy: "https://doc.rust-lang.org/clippy",
  rustfmt: "https://rust-lang.github.io/rustfmt",
  "golangci-lint": "https://golangci-lint.run",
  gofmt: "https://pkg.go.dev/cmd/gofmt",
  rubocop: "https://docs.rubocop.org",
  shellcheck: "https://www.shellcheck.net",
  hadolint: "https://github.com/hadolint/hadolint",
  markdownlint: "https://github.com/DavidAnson/markdownlint",
  "clang-tidy": "https://clang.llvm.org/extra/clang-tidy",
  "clang-format": "https://clang.llvm.org/docs/ClangFormat.html",
  cppcheck: "https://cppcheck.sourceforge.io",
  checkstyle: "https://checkstyle.org",
  "google-java-format": "https://github.com/google/google-java-format",
  phpcs: "https://github.com/PHPCSStandards/PHP_CodeSniffer",
  phpstan: "https://phpstan.org/user-guide/getting-started",
  swiftlint: "https://realm.github.io/SwiftLint",
  "swift-format": "https://github.com/apple/swift-format",
  ktlint: "https://pinterest.github.io/ktlint",
  luacheck: "https://luacheck.readthedocs.io",
  credo: "https://hexdocs.pm/credo",
  sqlfluff: "https://docs.sqlfluff.com",
  yamllint: "https://yamllint.readthedocs.io",
  taplo: "https://taplo.tamasfe.dev",
};

export function deriveUninstallHint(installHint: string): string | undefined {
  const hint = installHint.toLowerCase();
  if (hint.startsWith("npm install"))
    return installHint.replace(/\binstall\b/, "uninstall");
  if (hint.startsWith("pip install") || hint.startsWith("pip3 install"))
    return installHint.replace(/\binstall\b/, "uninstall");
  if (hint.startsWith("brew install"))
    return installHint.replace(/\binstall\b/, "uninstall");
  if (hint.startsWith("gem install"))
    return installHint.replace(/\binstall\b/, "uninstall");
  if (hint.startsWith("cargo install"))
    return installHint.replace(/\binstall\b/, "uninstall");
  if (hint.includes("rustup component add"))
    return installHint.replace("add", "remove");
  return undefined;
}

export function detectPackageManager(installHint: string): string {
  const hint = installHint.toLowerCase();
  if (hint.startsWith("npm ")) return "npm";
  if (hint.startsWith("pip ") || hint.startsWith("pip3 ")) return "pip";
  if (hint.startsWith("brew ")) return "Homebrew";
  if (hint.startsWith("gem ")) return "gem";
  if (hint.startsWith("cargo ")) return "Cargo";
  if (hint.includes("rustup")) return "rustup";
  if (hint.startsWith("go ")) return "go";
  return "Shell";
}
