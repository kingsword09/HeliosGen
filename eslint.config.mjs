import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  { files: ["frontend/image.tsx"], rules: { "@next/next/no-img-element": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "next-desktop/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Desktop build staging area (contains a copied Next.js server tree).
    "desktop/resources/**",
    ".mygo/**",
  ]),
]);

export default eslintConfig;
