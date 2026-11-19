// ESLint flat config — the strict Forge baseline (typescript-eslint strict +
// stylistic, type-checked), matching the frontend-repo template.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/models/**",
      "**/*.config.*",
      "vitest.config.ts",
      "eslint.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  // Accessibility: every JSX surface is linted against jsx-a11y's recommended
  // set. Fix violations with real labels, roles and keyboard handlers.
  {
    files: ["**/*.{jsx,tsx}"],
    ...jsxA11y.flatConfigs.recommended,
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
