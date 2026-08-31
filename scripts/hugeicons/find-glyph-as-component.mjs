/**
 * Find every place hugeicons glyph DATA is rendered as a React COMPONENT.
 *
 * This is the migration's sharpest failure mode. `IconSvgElement` is a nested
 * array; arrays satisfy `ReactNode`; so these sites typecheck clean and then
 * throw "Element type is invalid ... but got: array" at runtime.
 *
 * Detection needs BOTH strategies below, because neither is sufficient alone:
 *
 *   1. TYPE — ask the checker whether a JSX tag's type is glyph data. Note that
 *      `checker.isArrayType()` matches only mutable `Array<T>`; `IconSvgElement`
 *      is a READONLY array, so that alone misses most real cases.
 *
 *   2. SYNTAX — the checker reports `any` for props of components written as
 *      `const C: React.FC<P> = React.memo(({ ... }) => ...)`, because the props
 *      type does not propagate through `memo` here. In those files `tsc` accepts
 *      anything, so types tell us nothing and we must trace bindings by hand:
 *        - `import Plus from "@hugeicons/core-free-icons/Add01Icon"`  -> glyph
 *        - `{ addIcon: AddIcon = Plus }`  (destructured default is a glyph)
 *        - `{ addIcon: AddIcon }` where the component's props interface declares
 *          `addIcon?: IconSvgElement`
 *
 * Strategy 2 is what catches SidebarBase, which strategy 1 could never see.
 *
 * Usage: node scripts/hugeicons/find-glyph-as-component.mjs [--json]
 * Exits non-zero when anything is found, so it can gate CI.
 */
import ts from "typescript";
import path from "node:path";

const cwd = process.cwd();
const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

const GLYPH_MODULE = "@hugeicons/core-free-icons/";

function isGlyphType(type, depth = 0) {
  if (!type || depth > 3) return false;
  if (checker.isArrayType(type) || checker.isTupleType(type)) return true;
  const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  if (name && /^(IconSvg(Element|Object)|ReadonlyArray)$/.test(name)) return true;
  const text = checker.typeToString(type);
  if (/^IconSvg(Element|Object)$/.test(text)) return true;
  if (/^readonly .+\[\]$/.test(text)) return true;
  if (type.isUnion()) return type.types.some((t) => isGlyphType(t, depth + 1));
  return false;
}

/** Members of a props interface that are declared as glyph data. */
function glyphPropsOf(typeNode) {
  const out = new Set();
  if (!typeNode) return out;
  const type = checker.getTypeFromTypeNode(typeNode);
  for (const prop of checker.getPropertiesOfType(type)) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!decl) continue;
    const t = checker.getTypeOfSymbolAtLocation(prop, decl);
    if (isGlyphType(t)) out.add(prop.getName());
  }
  return out;
}

const findings = [];

/**
 * Resolve what a JSX tag identifier is actually BOUND to, regardless of how it
 * was declared — import, const, destructured prop, function parameter. Earlier
 * versions of this script enumerated declaration forms and kept missing one
 * (variable-assigned arrows but not `function` declarations, and so on).
 * Going through the symbol makes the declaration form irrelevant.
 */
function glyphViaSymbol(tag) {
  const sym = checker.getSymbolAtLocation(tag);
  if (!sym) return false;
  const decls = sym.declarations ?? [];
  for (const decl of decls) {
    // declared type of the binding itself
    try {
      const t = checker.getTypeOfSymbolAtLocation(sym, decl);
      if (isGlyphType(t)) return true;
    } catch {
      /* checker can throw on some synthetic symbols; fall through */
    }
    // import default from a glyph module
    if (
      ts.isImportClause(decl) &&
      ts.isImportDeclaration(decl.parent) &&
      ts.isStringLiteral(decl.parent.moduleSpecifier) &&
      decl.parent.moduleSpecifier.text.startsWith(GLYPH_MODULE)
    ) {
      return true;
    }
    // destructured binding whose default value is a glyph
    if (ts.isBindingElement(decl) && decl.initializer) {
      const init = decl.initializer;
      if (ts.isIdentifier(init)) {
        const isym = checker.getSymbolAtLocation(init);
        const idecl = isym?.declarations?.[0];
        if (
          idecl &&
          ts.isImportClause(idecl) &&
          ts.isImportDeclaration(idecl.parent) &&
          ts.isStringLiteral(idecl.parent.moduleSpecifier) &&
          idecl.parent.moduleSpecifier.text.startsWith(GLYPH_MODULE)
        ) {
          return true;
        }
      }
    }
    // `const X = <glyph>`
    if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isIdentifier(decl.initializer)) {
      const isym = checker.getSymbolAtLocation(decl.initializer);
      const idecl = isym?.declarations?.[0];
      if (
        idecl &&
        ts.isImportClause(idecl) &&
        ts.isImportDeclaration(idecl.parent) &&
        ts.isStringLiteral(idecl.parent.moduleSpecifier) &&
        idecl.parent.moduleSpecifier.text.startsWith(GLYPH_MODULE)
      ) {
        return true;
      }
    }
  }
  return false;
}

for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile) continue;
  if (!sf.fileName.startsWith(path.join(cwd, "src"))) continue;

  // --- purely syntactic pass -----------------------------------------------
  // The checker reports `any` for some destructured params even when the
  // annotation is present and correct, so type queries cannot be the only
  // signal. Read the declared type TEXT instead: a member typed
  // `IconSvgElement`, `IconSvgObject`, or `typeof <glyphImport>` is glyph data,
  // and any binding of that member name is too.
  const glyphImports = new Set();
  for (const st of sf.statements) {
    if (
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.moduleSpecifier.text.startsWith(GLYPH_MODULE) &&
      st.importClause?.name
    ) {
      glyphImports.add(st.importClause.name.text);
    }
  }
  const typeTextIsGlyph = (node) => {
    if (!node) return false;
    const text = node.getText(sf);
    if (/\bIconSvg(Element|Object)\b/.test(text)) return true;
    return [...glyphImports].some((g) =>
      new RegExp(`\\btypeof\\s+${g}\\b`).test(text),
    );
  };
  const glyphMembers = new Set();
  const scanMembers = (node) => {
    if (
      (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) &&
      node.members
    ) {
      for (const m of node.members) {
        if (ts.isPropertySignature(m) && m.name && typeTextIsGlyph(m.type)) {
          glyphMembers.add(m.name.getText(sf));
        }
      }
    }
    if (ts.isTypeAliasDeclaration(node) && node.type) scanMembers(node.type);
    ts.forEachChild(node, scanMembers);
  };
  scanMembers(sf);

  const syntacticGlyphNames = new Set(glyphImports);
  const scanBindings = (node) => {
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const declared = node.propertyName?.getText(sf) ?? node.name.text;
      const defIsGlyph =
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        glyphImports.has(node.initializer.text);
      if (defIsGlyph || glyphMembers.has(declared)) {
        syntacticGlyphNames.add(node.name.text);
      }
    }
    ts.forEachChild(node, scanBindings);
  };
  scanBindings(sf);

  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName;
      if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text) && tag.text !== "HugeiconsIcon") {
        const byType = isGlyphType(checker.getTypeAtLocation(tag));
        const bySymbol = byType ? false : glyphViaSymbol(tag);
        const bySyntax =
          byType || bySymbol ? false : syntacticGlyphNames.has(tag.text);
        if (byType || bySymbol || bySyntax) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          findings.push({
            file: path.relative(cwd, sf.fileName),
            line: line + 1,
            tag: tag.text,
            how: byType ? "type" : bySymbol ? "symbol" : "syntax",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  for (const f of findings) {
    console.log(`${f.file}:${f.line}  <${f.tag} ... />   [${f.how}]`);
  }
  console.log(`\nTOTAL glyph-data-as-component: ${findings.length}`);
}
process.exit(findings.length ? 2 : 0);
