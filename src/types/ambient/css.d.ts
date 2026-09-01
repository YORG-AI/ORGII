/**
 * Side-effect CSS imports (e.g. `import "@xterm/xterm/css/xterm.css"`).
 * Under moduleResolution "bundler" TypeScript verifies side-effect imports
 * resolve (TS2882); webpack/rspack load them via css-loader at build time.
 * SCSS modules are declared separately in scss.d.ts.
 */
declare module "*.css";
