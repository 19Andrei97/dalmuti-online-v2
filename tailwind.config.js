"use strict";

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.html", "./src/ts/**/*.ts", "./src/js/**/*.js"],
  // `main.ts` builds these class names at runtime (`role-${role}`), so the
  // content scanner cannot see them and would purge the rules otherwise.
  safelist: [
    "role-greaterDalmuti",
    "role-lesserDalmuti",
    "role-merchant",
    "role-lesserPeon",
    "role-greaterPeon",
  ],
  theme: {
    extend: {
      colors: {
        // Medieval parchment / ink / heraldry palette.
        parchment: {
          DEFAULT: "#f4f1de",
          dark: "#e7dcc0",
          deeper: "#d8c69b",
        },
        ink: {
          DEFAULT: "#2a2320",
          soft: "#4a4038",
        },
        royal: {
          DEFAULT: "#3d405b",
          light: "#6d708a",
          lighter: "#a2a6c5",
        },
        gold: {
          DEFAULT: "#c9a227",
          light: "#e6c766",
          dark: "#8a6d1a",
        },
        herald: {
          DEFAULT: "#8c2f2f",
          light: "#b14a3f",
          dark: "#5f1f1f",
        },
        forest: {
          DEFAULT: "#4f6f52",
          light: "#81b29a",
          dark: "#33503a",
        },
      },
      fontFamily: {
        display: ["Cinzel", "Georgia", "serif"],
        body: ["MedievalSharp", "Georgia", "serif"],
      },
      boxShadow: {
        card: "0 6px 14px rgba(20, 14, 8, 0.45)",
        banner: "inset 0 0 0 1px rgba(201,162,39,.5), 0 8px 24px rgba(0,0,0,.35)",
      },
    },
  },
  plugins: [],
};
