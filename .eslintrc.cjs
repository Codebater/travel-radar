/**
 * Scoped to the live search path. arkalis/ and awardwiz-scrapers/ are inherited
 * AwardWiz code that is not linted here — see DEVELOPMENT.md.
 */
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: ["arkalis/**", "awardwiz-scrapers/**", "node_modules/**", "*.js", "scripts/**"],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    // Downgraded, not disabled: these flag pre-existing dead code and empty
    // catch blocks that Phase 1 deliberately left alone. They still show up in
    // `npm run lint` output without failing the baseline.
    "@typescript-eslint/no-unused-vars": "warn",
    "no-empty": "warn",
  },
}
