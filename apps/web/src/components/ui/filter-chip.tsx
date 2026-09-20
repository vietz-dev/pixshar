"use client";

import { chakra } from "@chakra-ui/react";

/**
 * Pill-shaped toggle used by the gallery photographer filter and (from phase 5)
 * the admin event detail filter bar. Both rendered an identical 12-property
 * inline style object before the migration.
 */
export const FilterChip = chakra("button", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    h: "28px",
    px: "11px",
    borderRadius: "pill",
    borderWidth: "1px",
    fontSize: "12.5px",
    fontWeight: "500",
    whiteSpace: "nowrap",
    cursor: "pointer",
    transition: "background .15s, color .15s, border-color .15s",
  },
  variants: {
    active: {
      true: { bg: "fg", borderColor: "fg", color: "surface" },
      false: {
        bg: "surface",
        borderColor: "border",
        color: "gray.600",
        _hover: { bg: "bg" },
      },
    },
  },
  defaultVariants: { active: false },
});

/** The tabular count suffix every chip renders after its label. */
export const FilterChipCount = chakra("span", {
  base: {
    ml: "5px",
    opacity: 0.6,
    fontSize: "11.5px",
    fontVariantNumeric: "tabular-nums",
  },
});
