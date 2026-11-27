import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (
            /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)
          ) {
            return "vendor-react";
          }
          if (id.includes("three")) return "vendor-three";
          if (id.includes("pdfjs-dist")) return "vendor-pdfjs";
          if (id.includes("@tiptap") || id.includes("prosemirror")) {
            return "vendor-tiptap";
          }
          if (
            id.includes("marked") ||
            id.includes("turndown") ||
            id.includes("dompurify") ||
            id.includes("dxf-parser")
          ) {
            return "vendor-parsers";
          }
          if (id.includes("lucide-react")) return "vendor-icons";
        },
      },
    },
  },
});
