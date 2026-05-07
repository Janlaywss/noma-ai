import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 10_000,
    reporters: ["default"],
    clearMocks: true,
    restoreMocks: true,
  },
});
