/**
 * The viz server: vite in dev mode over the viz/ app, plus one middleware
 * serving the target's graph artifact at /graph.json — the same relative
 * path the static export uses, so the app is host-agnostic. The vite cache
 * is kept in gnosis's own node_modules, never the target's.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { packageRoot } from '../paths.ts';

export async function serveGraph(graphPath: string, port: number): Promise<void> {
  const gnosisRoot = packageRoot();
  const server = await createServer({
    root: join(gnosisRoot, 'app'),
    configFile: false,
    cacheDir: join(gnosisRoot, 'node_modules', '.vite-gnosis'),
    server: { port },
    plugins: [
      react(),
      {
        name: 'gnosis-api',
        configureServer(dev) {
          dev.middlewares.use('/graph.json', (_req, res) => {
            if (!existsSync(graphPath)) {
              res.statusCode = 404;
              res.end('graph not found — run gnosis scan first');
              return;
            }
            res.setHeader('content-type', 'application/json');
            res.end(readFileSync(graphPath));
          });
        },
      },
    ],
  });
  await server.listen();
  server.printUrls();
}
