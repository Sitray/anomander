// The window's build, with Tauri's conventions: a fixed dev port the shell's `devUrl` points
// at, no screen clearing so Rust's output stays readable, and a build into `dist`.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Rust rebuilds would otherwise reload the page.
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // Tauri's WebView on macOS is WebKit; this keeps the output within what it runs.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'safari16',
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
});
