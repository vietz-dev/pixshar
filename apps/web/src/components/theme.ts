import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

/**
 * Single source of truth for colors, radii, fonts and shadows.
 *
 * Call sites must use semantic token *names* (surface, fg, fgMuted, border, …)
 * rather than raw hex, so adding dark mode later is one `_dark` pass in here.
 *
 * `accent` is declared both as a flat color (`bg="accent"`) and as a full
 * colorPalette (`colorPalette="accent"` on Button/Badge/Progress/Tabs).
 */
/** Top-left highlight every event cover gradient carries. */
const coverSheen = (alpha: number) =>
  `radial-gradient(120% 90% at 28% 16%,rgba(255,255,255,${alpha}) 0%,rgba(255,255,255,0) 46%)`;

const config = defineConfig({
  globalCss: {
    body: {
      bg: "bg",
      color: "fg",
      fontFamily: "body",
      fontSmooth: "antialiased",
    },
    "::selection": { bg: "accent.200" },
    ".pxscroll::-webkit-scrollbar": { width: "11px", height: "11px" },
    ".pxscroll::-webkit-scrollbar-thumb": {
      background: "#d4d4d8",
      borderRadius: "8px",
      border: "3px solid transparent",
      backgroundClip: "padding-box",
    },
    ".pxscroll::-webkit-scrollbar-track": { background: "transparent" },
  },
  theme: {
    tokens: {
      fonts: {
        body: { value: "'Geist', system-ui, -apple-system, sans-serif" },
        heading: { value: "'Geist', system-ui, -apple-system, sans-serif" },
        serif: { value: "'Newsreader', serif" },
      },
      radii: {
        control: { value: "8px" },
        card: { value: "12px" },
        pill: { value: "999px" },
      },
      shadows: {
        focusRing: { value: "0 0 0 3px rgba(37,99,235,.16)" },
      },
      gradients: {
        // Gallery cover art — gate page and gallery hero.
        cover: { value: "linear-gradient(150deg,#3a4a6b 0%,#7c91b8 100%)" },
        // Login page backdrop.
        authCover: {
          value: "radial-gradient(120% 80% at 50% 0%,#fafafa 0%,{colors.bg} 100%)",
        },
        // Event card thumbnails on /admin — picked by index, purely decorative.
        eventCover: {
          1: { value: `${coverSheen(0.5)},linear-gradient(150deg,#f6dcab 0%,#c8843f 100%)` },
          2: { value: `${coverSheen(0.35)},linear-gradient(150deg,#3a4a6b 0%,#7c91b8 100%)` },
          3: { value: `${coverSheen(0.5)},linear-gradient(150deg,#f3dada 0%,#d18f8f 100%)` },
          4: { value: `${coverSheen(0.5)},linear-gradient(150deg,#cfe0cd 0%,#6e8f68 100%)` },
          5: { value: `${coverSheen(0.5)},linear-gradient(150deg,#d9dbde 0%,#878d95 100%)` },
          6: { value: `${coverSheen(0.5)},linear-gradient(150deg,#f8d6c2 0%,#df8763 100%)` },
          7: { value: `${coverSheen(0.5)},linear-gradient(150deg,#e0d9ee 0%,#9989c2 100%)` },
          8: { value: `${coverSheen(0.5)},linear-gradient(150deg,#ece1cd 0%,#c0a673 100%)` },
          9: { value: `${coverSheen(0.5)},linear-gradient(150deg,#cfe5e2 0%,#6ba39b 100%)` },
          10: { value: `${coverSheen(0.5)},linear-gradient(150deg,#e4cdd9 0%,#a76f8b 100%)` },
          11: { value: `${coverSheen(0.45)},linear-gradient(150deg,#cccdcf 0%,#5a5d65 100%)` },
          12: { value: `${coverSheen(0.5)},linear-gradient(150deg,#f4e9d4 0%,#d7be8c 100%)` },
        },
      },
      colors: {
        // Upload tray avatar tints — decorative, picked at random per file.
        tint: {
          1: { value: "#fecaca" },
          2: { value: "#bfdbfe" },
          3: { value: "#bbf7d0" },
          4: { value: "#fde68a" },
          5: { value: "#ddd6fe" },
          6: { value: "#fbcfe8" },
          7: { value: "#99f6e4" },
          8: { value: "#fed7aa" },
          9: { value: "#c7d2fe" },
          10: { value: "#e9d5ff" },
        },
        accent: {
          50: { value: "#eff6ff" },
          100: { value: "#dbeafe" },
          200: { value: "#bfdbfe" },
          300: { value: "#93c5fd" },
          400: { value: "#60a5fa" },
          500: { value: "#3b82f6" },
          600: { value: "#2563eb" },
          700: { value: "#1d4ed8" },
          800: { value: "#1e40af" },
          900: { value: "#1e3a8a" },
          950: { value: "#172554" },
        },
      },
    },
    semanticTokens: {
      colors: {
        bg: { value: "#f4f4f5" },
        surface: { value: "#fff" },
        border: { value: "#e4e4e7" },
        fg: { value: "#18181b" },
        fgMuted: { value: "#71717a" },
        fgSubtle: { value: "#a1a1aa" },
        danger: { value: "#dc2626" },
        success: { value: "#16a34a" },
        warning: { value: "#d97706" },
        accent: {
          DEFAULT: { value: "{colors.accent.600}" },
          contrast: { value: "#fff" },
          fg: { value: "{colors.accent.700}" },
          subtle: { value: "{colors.accent.50}" },
          muted: { value: "{colors.accent.100}" },
          emphasized: { value: "{colors.accent.200}" },
          solid: { value: "{colors.accent.600}" },
          focusRing: { value: "{colors.accent.600}" },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
