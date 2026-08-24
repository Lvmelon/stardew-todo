import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const migrations = await readD1Migrations(path.join(root, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: path.join(root, "wrangler.jsonc") },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    })),
  ],
  test: {
    include: ["test/**/*.test.js"],
    setupFiles: ["./test/setup.js"],
    pool: "workers",
    maxWorkers: 1,
    minWorkers: 1,
  },
});
