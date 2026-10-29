import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served by the app's server under /v2/, beside the old UI at /.
export default defineConfig({
  base: "/v2/",
  plugins: [react()],
});
