/** @type {import('tailwindcss').Config} */

const COLOR_STEPS_3 = [1, 2, 3];
const COLOR_STEPS_4 = [1, 2, 3, 4];
const COLOR_STEPS_6 = [1, 2, 3, 4, 5, 6];
const COLOR_STEPS_7 = [1, 2, 3, 4, 5, 6, 7];

const colorVariable = (tokenName) =>
  `color-mix(in srgb, var(--color-${tokenName}) calc(<alpha-value> * 100%), transparent)`;

const colorScale = (tokenName, steps) =>
  Object.fromEntries(
    steps.map((step) => [step, colorVariable(`${tokenName}-${step}`)])
  );

module.exports = {
  content: ["./src/**/*.{html,ts,tsx,js,jsx}"],
  theme: {
    extend: {
      colors: {
        pane: {
          raised: colorVariable("pane-raised"),
          input: colorVariable("pane-input"),
        },
        workstation: {
          bg: colorVariable("workstation-bg"),
        },
        chat: {
          pane: colorVariable("chat-pane"),
          input: colorVariable("chat-input"),
          container: colorVariable("chat-container"),
        },
        button: {
          hover: colorVariable("button-hover"),
        },
        surface: {
          hover: colorVariable("surface-hover"),
          selected: colorVariable("surface-selected"),
          "selected-hover": colorVariable("surface-selected-hover"),
        },
        sidebar: {
          selected: "var(--sidebar-selected-row-bg)",
        },
        event: {
          block: colorVariable("event-block"),
          "block-fade": colorVariable("event-block-fade"),
        },
        primary: {
          ...colorScale("primary", COLOR_STEPS_7),
          container: colorVariable("primary-container"),
        },
        bg: {
          ...colorScale("bg", COLOR_STEPS_3),
          overlay: "rgba(0, 0, 0, 0.5)",
          "overlay-heavy": "rgba(0, 0, 0, 0.7)",
        },
        border: colorScale("border", COLOR_STEPS_3),
        text: {
          ...colorScale("text", COLOR_STEPS_4),
          white: colorVariable("text-white"),
        },
        fill: colorScale("fill", COLOR_STEPS_4),
        // IMPORTANT:
        // Tailwind expects `white` to be a string or an object with `DEFAULT`.
        // If we define only `white.100`, classes like `text-white` / `bg-white`
        // (and `text-white/70`) won't be generated correctly.
        white: {
          DEFAULT: "#ffffff",
          100: "#ffffff",
        },
        danger: colorScale("danger", COLOR_STEPS_6),
        success: colorScale("success", COLOR_STEPS_6),
        warning: colorScale("warning", COLOR_STEPS_6),
        purple: colorScale("purple", COLOR_STEPS_7),
        merged: {
          DEFAULT: colorVariable("merged-button-bg"),
          hover: colorVariable("merged-button-hover"),
          active: colorVariable("merged-button-active"),
          contrast: colorVariable("merged-button-contrast"),
        },
      },
      spacing: {
        180: "180px",
      },
      borderRadius: {
        page: "var(--radius-page)",
      },
      screens: {
        lg: "960px",
      },
      boxShadow: {
        // Floating dropdown shadow; light/dark values live in src/index.scss.
        dropdown: "var(--shadow-dropdown)",
        // Half-strength surface shadow shared by inputs, trails, and inline cards.
        "dropdown-soft": "var(--shadow-dropdown-soft)",
        // Sticky header shadow - used in Git changes view file headers
        "sticky-header": "0 4px 8px -2px rgba(0, 0, 0, 0.3)",
        // Liquid Glass Pattern - Light Theme Shadows
        // Subtle, soft shadows that complement the glass material
        "light-ultrathin":
          "0 2px 8px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02)",
        "light-thin":
          "0 4px 12px rgba(0, 0, 0, 0.06), 0 2px 4px rgba(0, 0, 0, 0.04)",
        "light-medium":
          "0 8px 20px rgba(0, 0, 0, 0.08), 0 4px 8px rgba(0, 0, 0, 0.06)",
        "light-thick":
          "0 12px 28px rgba(0, 0, 0, 0.10), 0 6px 12px rgba(0, 0, 0, 0.08)",
        // Liquid Glass Pattern - Dark Theme Shadows
        // Deeper shadows for depth against dark backgrounds
        "dark-ultrathin":
          "0 2px 8px rgba(0, 0, 0, 0.20), 0 1px 2px rgba(0, 0, 0, 0.15)",
        "dark-thin":
          "0 4px 12px rgba(0, 0, 0, 0.30), 0 2px 4px rgba(0, 0, 0, 0.25)",
        "dark-medium":
          "0 8px 20px rgba(0, 0, 0, 0.40), 0 4px 8px rgba(0, 0, 0, 0.35)",
        "dark-thick":
          "0 12px 28px rgba(0, 0, 0, 0.50), 0 6px 12px rgba(0, 0, 0, 0.45)",
      },
      fontSize: {
        xs: ["0.75rem", "1.25rem"],
        sm: ["0.875rem", "1.375rem"],
      },
      animation: {
        marquee: "marquee 2s linear infinite",
        "stamp-slam": "stamp-slam 0.4s ease-out",
        "fade-in-up": "fade-in-up 0.6s ease-out",
        "progress-slide": "progress-slide 1s ease-in-out infinite",
        "shimmer-text": "shimmer-text 2.5s linear infinite",
        "fade-in": "fade-in 250ms ease-out both",
        "dropdown-in": "dropdown-in 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
      },
      keyframes: {
        marquee: {
          "0%": { backgroundPosition: "0% 0%" },
          "100%": { backgroundPosition: "200% 0%" },
        },
        "stamp-slam": {
          "0%": { transform: "scale(0) rotate(0deg)", opacity: "0" },
          "50%": { transform: "scale(1.1) rotate(-5deg)", opacity: "0.8" },
          "100%": { transform: "scale(1) rotate(0deg)", opacity: "1" },
        },
        "fade-in-up": {
          "0%": { transform: "translateY(20px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        "progress-slide": {
          "0%": { left: "-33%" },
          "100%": { left: "100%" },
        },
        "shimmer-text": {
          "0%": { backgroundPosition: "200% 50%" },
          "100%": { backgroundPosition: "-100% 50%" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "dropdown-in": {
          "0%": { opacity: "0", transform: "translateY(-8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      backgroundImage: {
        "paper-texture":
          'url(\'data:image/svg+xml,%3Csvg width="100" height="100" xmlns="http://www.w3.org/2000/svg"/%3E\')',
        "leather-texture": "linear-gradient(135deg, #2c2416 0%, #1a1410 100%)",
      },
      perspective: {
        1500: "1500px",
      },
      transformStyle: {
        "preserve-3d": "preserve-3d",
      },
      backfaceVisibility: {
        hidden: "hidden",
      },
    },
  },
  plugins: [
    require("tailwind-scrollbar-hide"),
    require("@tailwindcss/container-queries"),
  ],
  variants: {
    extend: {
      opacity: ["group-hover"],
    },
  },
};
