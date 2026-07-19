import { defineConfig } from 'vitest/config';
import { cloudflare } from '@cloudflare/vite-plugin';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePath } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const isTest = process.env.VITEST === 'true' || process.argv.some((argument) => argument.includes('vitest'));

export default defineConfig({
  plugins: [
    ...(!isTest ? [cloudflare()] : []),
    viteStaticCopy({
      targets: [
        {
          src: normalizePath(
            resolve(projectRoot, 'node_modules/@mediapipe/tasks-vision/wasm/*'),
          ),
          dest: 'mediapipe/wasm',
          rename: { stripBase: true },
        },
      ],
    }),
  ],
  worker: {
    format: 'es',
  },
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            orion: resolve(projectRoot, 'index.html'),
            'stt-compare': resolve(projectRoot, 'stt-compare.html'),
          },
          output: {
            // Keep a release namespace in asset URLs so existing visitors never retain an
            // immutable pre-agent bundle after a Worker deployment.
            entryFileNames: 'assets/[name]-agent-v1-[hash].js',
            chunkFileNames: 'assets/[name]-agent-v1-[hash].js',
            assetFileNames: 'assets/[name]-agent-v1-[hash][extname]',
          },
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
