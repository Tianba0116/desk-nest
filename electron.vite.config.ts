import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          companion: resolve(__dirname, 'src/preload/companion.ts'),
          bubble: resolve(__dirname, 'src/preload/bubble.ts'),
          chat: resolve(__dirname, 'src/preload/chat.ts'),
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          pet: resolve(__dirname, 'src/renderer/pet.html'),
          home: resolve(__dirname, 'src/renderer/home.html'),
          bubble: resolve(__dirname, 'src/renderer/bubble.html'),
          chat: resolve(__dirname, 'src/renderer/chat.html'),
        },
      },
    },
  },
});
