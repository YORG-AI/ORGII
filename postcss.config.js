// module.exports = {
//     plugins: [
//       require('postcss-import'),
//       require('tailwindcss/nesting')(require('postcss-nesting')),
//       require('autoprefixer'),
//       require('tailwindcss'),
//     ]
// }
module.exports = {
  // Resolve plugins from the project config instead of asking postcss-loader to
  // resolve string names from its pnpm virtual-store path. The latter breaks
  // when a worktree reuses a symlinked node_modules directory.
  plugins: [require("tailwindcss"), require("autoprefixer")],
};
