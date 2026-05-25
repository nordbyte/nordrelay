import { defineConfig } from "vitest/config";

const isWindows = process.platform === "win32";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: isWindows,
      },
    },
    setupFiles: ["./test/setup.ts"],
  },
});
