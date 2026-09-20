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
      colors: {
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
