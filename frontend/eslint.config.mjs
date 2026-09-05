import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Typed linting for the e2e suite only (QWB-54): a Promise used as a
    // boolean (`await x && promise`, `if (promise)`) is a lint error here,
    // not a silently always-true assertion. Needs type information, hence
    // the project service over frontend/tsconfig.json (checkJs on).
    files: ["e2e/**/*.mjs"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksConditionals: true },
      ],
      // no-misused-promises alone does NOT catch the bug this ticket is
      // about: `await waitForText(x) && promise` has type
      // `false | Promise<boolean>`, and that rule only reports a conditional
      // whose type is ALWAYS thenable. strict-boolean-expressions does report
      // it, because the type is not boolean. Every ordinary-truthiness
      // allowance below is on, so the rule stays silent on strings, numbers,
      // objects and nullables and only speaks up for a type that has no
      // business in a condition -- a Promise. Verified: reinstating the old
      // shape produces two errors here and nothing else in e2e/.
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowAny: true,
          allowString: true,
          allowNumber: true,
          allowNullableBoolean: true,
          allowNullableString: true,
          allowNullableNumber: true,
          allowNullableObject: true,
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
