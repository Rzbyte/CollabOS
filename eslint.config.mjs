import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "src/generated/**", // Prisma output — generated, not authored.
      "playwright-report/**",
      "test-results/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused args are allowed when prefixed with `_`, which keeps interface
      // implementations readable.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The audit log and Mind replies genuinely traffic in `unknown`; we narrow
      // explicitly rather than banning the type.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Scripts and tests run in Node and legitimately log to the console.
    files: ["scripts/**/*.ts", "prisma/**/*.ts", "tests/**/*.ts", "src/worker/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
