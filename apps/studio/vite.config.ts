import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.GATEWAY_API_URL ?? "http://127.0.0.1:4180";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/studio": { target: api, changeOrigin: false }, "/v1": { target: api, changeOrigin: false }, "/mcp": { target: api, changeOrigin: false } }
  }
});
