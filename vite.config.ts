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

/**
 * Public base path. Default './' (relative) so the same `dist/` works when served
 * from a domain root (`npm run preview`, any static host) AND from a project
 * GitHub Pages subpath (https://grot666.github.io/pose-lab-spike/). All runtime
 * asset URLs (models, wasm, audio) are resolved from import.meta.env.BASE_URL
 * against window.location, so relative works. Override with an absolute path if
 * a host needs it, e.g. `BASE_PATH=/pose-lab-spike/ npm run build`.
 */
const base = process.env.BASE_PATH || './';

export default defineConfig({
  base,
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
