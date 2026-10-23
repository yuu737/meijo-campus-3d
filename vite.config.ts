import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  publicDir: "web-public",
  css: { postcss: { plugins: [] } },
  server: {
    host: "127.0.0.1",
    watch: {
      ignored: ["**/dist/**"],
    },
  },
  build: { target: "es2022", sourcemap: true },
});
