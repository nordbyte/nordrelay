import { defineConfig } from "vitest/config";

const isWindows = process.platform === "win32";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    pool: "forks",
    maxWorkers: isWindows ? 1 : undefined,
    setupFiles: ["./test/setup.ts"],
  },
});
