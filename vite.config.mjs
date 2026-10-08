import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = "http://localhost:3000";
const root = import.meta.dirname.replaceAll("\\", "/");

export default defineConfig({
  plugins: [react()],
  // public/ holds unrelated raw photos; they must not be copied into the build.
  publicDir: false,
  server: {
    port: 5173,
    // The project root doubles as the Vite root, so keep customer data and
    // server code out of the dev server.
    fs: {
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        `${root}/data/**`,
        `${root}/server/**`,
        `${root}/test/**`,
        `${root}/public/**`,
        `${root}/dist/**`,
        `${root}/*.js`,
        `${root}/*.json`,
        `${root}/*.bat`,
        `${root}/*.jpg`,
        `${root}/*.txt`,
      ],
    },
    proxy: {
      "/api": backend,
      "/uploads": backend,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        admin: resolve(import.meta.dirname, "admin.html"),
      },
    },
  },
});
