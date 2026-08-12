import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // 127.0.0.1, not localhost: Node resolves localhost to ::1 first on
        // Windows, while uvicorn binds 127.0.0.1 only — causing proxy hangs.
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})