// Tailwind v4: the dedicated PostCSS plugin resolves `@import "tailwindcss"`
// (from src/tailwind.css, reached via src/index.scss) and compiles utilities.
// Autoprefixer stays for the non-Tailwind SCSS that flows through the same
// postcss-loader chain; Tailwind's own output is prefixed by Lightning CSS.
module.exports = {
  plugins: {
    "@tailwindcss/postcss": {},
    autoprefixer: {},
  },
};
