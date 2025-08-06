import { defineConfig } from 'vite';
import path from 'path';
import dts from 'vite-plugin-dts';
import reactSwc from '@vitejs/plugin-react-swc';

export default defineConfig({
  plugins: [
    reactSwc(),
    dts({
      insertTypesEntry: true,
    }),
  ],
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      name: 'NexusChromeAdapter',
      fileName: (format) => `index.${format === 'es' ? 'mjs' : 'js'}`,
    },
    rollupOptions: {
      external: ['@nexus-js/core'],
      output: {
        globals: {
          '@nexus-js/core': 'NexusCore',
        },
      },
    },
  },
}); 