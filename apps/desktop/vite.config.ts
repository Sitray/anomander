import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The window of the desktop app. Tauri loads `http://localhost:1420` in development
// (`src-tauri/tauri.conf.json`, `devUrl`) and `dist/` in a build (`frontendDist`).
export default defineConfig({
  plugins: [react()],
  // Keep the Rust compiler's output on screen under `tauri dev`.
  clearScreen: false,
  server: {
    port: 1420,
    // Tauri expects exactly this port: fail instead of moving to another.
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The WebView is the system's WebKit on macOS.
    target: 'safari15',
  },
});
