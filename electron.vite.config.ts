import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Native module — required at runtime from node_modules (see
        // electron-builder.yml files/asarUnpack), not bundleable by vite.
        external: ['onnxruntime-node']
      }
    }
  },
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
