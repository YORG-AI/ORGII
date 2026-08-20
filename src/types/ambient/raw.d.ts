// `?raw` resource-query imports: the default export is the file's text
// content. Webpack serves these through the `resourceQuery: /raw/` +
// `type: "asset/source"` rule in webpack.config.js; vitest resolves them
// through vite's built-in `?raw` support. Used to inline the React 18 UMD
// runtimes into generated canvas-artifact documents
// (src/engines/ChatPanel/blocks/CanvasInlineCard/reactArtifactDocument.ts).
declare module "*?raw" {
  const content: string;
  export default content;
}
