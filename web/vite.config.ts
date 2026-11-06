import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// base relatif supaya hasil build yang sama bisa disajikan di /agen/v2/ maupun /agen/.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    // `npm run dev` membuka http://localhost:5173/agen/v2/ dan meneruskan API ke dashboard yang jalan.
    proxy: {
      "^/agen/(?!v2)": { target: "http://127.0.0.1:4180", ws: true, changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
