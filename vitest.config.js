import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      VITEST: "true",
      JWT_SECRET: "ci-test-secret",
      ENCRYPTION_KEY: "ci-encryption-key-for-tests",
      FRONTEND_ORIGIN: "http://localhost:3000",
      REPOMIND_API_URL: "http://repomind.test",
      NODE_ENV: "test",
    },
    fileParallelism: false,
    hookTimeout: 120000,
    testTimeout: 60000,
  },
});
