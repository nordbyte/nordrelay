import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    setupFiles: ["./test/setup.ts"],
  },
});
