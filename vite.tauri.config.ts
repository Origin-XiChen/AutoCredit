import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  server: {
    port: 5174,
    strictPort: true
  },
  build: {
    outDir: resolve('dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve('src/renderer/index.html'),
        popup: resolve('src/renderer/popup.html')
      }
    }
  }
})
