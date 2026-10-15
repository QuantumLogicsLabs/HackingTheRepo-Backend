import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";

const sentryPlugin =
  process.env.SENTRY_AUTH_TOKEN &&
  process.env.SENTRY_ORG &&
  process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        url: process.env.SENTRY_URL || "https://sentry.io/",
        release:
          process.env.SENTRY_RELEASE ||
          process.env.npm_package_version ||
          "frontend@local",
        include: "./dist",
        ignore: ["node_modules", "vite.config.js"],
        setCommits: { auto: true },
        sourceMaps: {
          include: ["dist/assets"],
        },
        silent: true,
      })
    : null;

export default defineConfig({
  plugins: [react(), ...(sentryPlugin ? [sentryPlugin] : [])],
  build: {
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
      "/metrics": {
        target: "http://localhost:9100",
        changeOrigin: true,
        configure: (proxy) => {
          let warned = false;
          proxy.on("error", (_err, _req, res) => {
            if (!warned) {
              console.warn(
                "[metrics] metrics server unavailable at http://localhost:9100 — events dropped. Run `npm run metrics` to enable.",
              );
              warned = true;
            }
            if (res && !res.headersSent && typeof res.writeHead === "function") {
              res.writeHead(204);
            }
            if (res && typeof res.end === "function") {
              res.end();
            }
          });
        },
      },
    },
  },
});
