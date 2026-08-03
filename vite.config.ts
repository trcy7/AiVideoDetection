import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // The Python training pipeline and its model checkpoints (training/)
      // are not part of the frontend. Watching them is wasteful and, worse,
      // Vite crashes trying to watch a large .pt file while it's being copied
      // in (EBUSY: resource busy or locked). Exclude the whole directory.
      ignored: ['**/training/**'],
    },
  },
})
