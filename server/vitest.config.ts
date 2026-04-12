import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      DATABASE_URL: ":memory:",
      NODE_ENV: "test",
    },
  },
});
