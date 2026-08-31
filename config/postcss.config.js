// module.exports = {
//     plugins: [
//       require('postcss-import'),
//       require('tailwindcss/nesting')(require('postcss-nesting')),
//       require('autoprefixer'),
//       require('tailwindcss'),
//     ]
// }
module.exports = {
  plugins: {
    tailwindcss: { config: require.resolve("./tailwind.config.js") },
    autoprefixer: {},
  },
};
