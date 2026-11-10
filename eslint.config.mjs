export default [
  {
    ignores: ["**/node_modules/**", "extension/vendor/**", "**/*.min.js"],
  },
  {
    files: ["worker/**/*.{js,mjs,cjs}", "extension/**/*.{js,mjs,cjs}",
      "docs/js/**/*.{js,mjs,cjs}", "tests/**/*.{js,mjs,cjs}"],
    languageOptions: { ecmaVersion: "latest" },
    // No style migration or global-name cleanup in the initial rule set.
    rules: {
      "constructor-super": "error",
      "no-class-assign": "error",
      "no-compare-neg-zero": "error",
      "no-dupe-args": "error",
      "no-duplicate-case": "error",
      "no-new-native-nonconstructor": "error",
      "no-unsafe-negation": "error",
      "valid-typeof": "error",
    },
  },
];
