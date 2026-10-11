"use strict";

// Tailwind + autoprefixer build. Kept as CommonJS so `postcss-cli` can load it
// without an ESM/`"type"` change to the package.
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
