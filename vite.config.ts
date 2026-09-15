import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';

const BACKEND_PORT =
  process.env.PORT && /^\d+$/.test(process.env.PORT.trim())
    ? parseInt(process.env.PORT.trim(), 10)
    : 3000;

const CLIENT_PORT =
  process.env.CLIENT_PORT && /^\d+$/.test(process.env.CLIENT_PORT.trim())
    ? parseInt(process.env.CLIENT_PORT.trim(), 10)
    : 5173;

const HOST =
  process.env.HOST && process.env.HOST.trim().toLowerCase() === 'localhost'
    ? 'localhost'
    : '127.0.0.1';

/**
 * Middleware para garantir Host estrito (127.0.0.1 ou localhost) em TODAS as rotas
 * servidas pelo Vite em desenvolvimento, rejeitando categoricamente localhost.evil,
 * evil.localhost, 192.0.2.1 ou portas não autorizadas.
 */
function strictHostValidatorPlugin(): Plugin {
  return {
    name: 'strict-host-validator',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const activePort = server.config.server.port || CLIENT_PORT;
        const hostHeader = req.headers['host'];
        if (!hostHeader || typeof hostHeader !== 'string') {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Acesso rejeitado: Host não autorizado.' }));
          return;
        }

        const match = /^([a-zA-Z0-9.-]+)(?::(\d+))?$/.exec(hostHeader.trim());
        if (!match) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Acesso rejeitado: Host não autorizado.' }));
          return;
        }

        const hostname = match[1].toLowerCase();
        const portStr = match[2];

        // Apenas loopback exato é aceito
        if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Acesso rejeitado: Host não autorizado.' }));
          return;
        }

        // Se porta especificada, deve coincidir com a porta do servidor de desenvolvimento
        if (portStr !== undefined) {
          const port = parseInt(portStr, 10);
          if (port !== activePort) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'Acesso rejeitado: Host não autorizado.' }));
            return;
          }
        }

        next();
      });
    }
  };
}

export default defineConfig({
  root: 'src/frontend',
  plugins: [strictHostValidatorPlugin()],
  server: {
    host: HOST,
    port: CLIENT_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: true
  }
});
