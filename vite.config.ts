/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { parse } from 'yaml';

/**
 * Minimal YAML loader: `import data from './x.yaml'` -> parsed object.
 * The module is a plain ES module, so Vite HMR propagates edits to importers
 * that call import.meta.hot.accept('./x.yaml', ...) (see src/main.ts).
 */
function yamlPlugin(): Plugin {
  return {
    name: 'pose-lab:yaml',
    transform(code, id) {
      if (!/\.ya?ml$/.test(id.split('?')[0])) return null;
      let data: unknown;
      try {
        data = parse(code);
      } catch (err) {
        this.error(`YAML parse error in ${id}: ${(err as Error).message}`);
      }
      return { code: `export default ${JSON.stringify(data)};\n`, map: null };
    },
  };
}

const isTest = !!process.env.VITEST;

export default defineConfig({
  plugins: [yamlPlugin(), ...(isTest ? [] : [basicSsl()])],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
