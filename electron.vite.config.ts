import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { version } from './package.json'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // Minified: about half the bytes for V8 to parse and compile at every launch.
    build: { minify: true, rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    plugins: [react()],
    // The app's version (package.json), shown in Settings.
    define: { __APP_VERSION__: JSON.stringify(version) }
  }
})
