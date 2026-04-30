import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["**/node_modules/**"],
    },
  },
  resolve: {
    alias: {
      // Obsidian is external at bundle time; stub it in Node tests.
      obsidian: path.resolve(root, "tests/mocks/obsidian.ts"),
    },
  },
});
