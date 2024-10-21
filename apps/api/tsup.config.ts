import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', worker: 'src/worker.ts', 'db/cli': 'src/db/cli.ts', seed: 'scripts/seed.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // workspace packages (and the fixture generator used by the demo seed) are bundled
  noExternal: ['@fingraph/shared', '@fingraph/fixtures', 'pdf-lib'],
  onSuccess: async () => {
    cpSync('src/db/migrations', 'dist/migrations', { recursive: true });
  },
});
