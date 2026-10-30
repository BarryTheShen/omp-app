import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Relative asset paths: the app's server serves this old UI under /old/ (the new UI is its root), and its own previews
// serve it at /.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
});
