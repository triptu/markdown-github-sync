import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["test/**", "build.mjs", "eslint.config.mjs", "node_modules/**"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true } },
  },
]);
