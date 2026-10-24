import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, UsageStatus } from '../shared/types.js';
import { isAllowedHost } from './hostValidator.js';
import { handleHealthRequest } from './routes/health.js';
import { handlePrivacyRequest } from './routes/privacy.js';
import { handleDoctorRequest } from './routes/doctor.js';
import { handleUsageRequest } from './routes/usage.js';
import { handleOgraRoute, handleVoiceRoute, type VoiceRouteDeps } from './voice/routes.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

export function createRequestHandler(
  config: AppConfig,
  clientDistDir?: string,
  voiceDeps?: VoiceRouteDeps
): (req: IncomingMessage, res: ServerResponse) => void {
  // Portas permitidas: a porta da própria API e a porta do cliente de desenvolvimento
  const allowedPorts = [config.port, config.clientPort];

  const staticDir =
    clientDistDir ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client');

  return (req: IncomingMessage, res: ServerResponse) => {
    // 1. Validação estrita do cabeçalho Host
    if (!isAllowedHost(req.headers.host, allowedPorts)) {
      res.writeHead(403, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ error: 'Acesso rejeitado: Host não autorizado.' }));
      return;
    }

    // 2. Parseamento seguro da URL
    const rawUrl = req.url || '/';
    let pathname: string;
    try {
      const parsedUrl = new URL(rawUrl, `http://127.0.0.1:${config.port}`);
      pathname = parsedUrl.pathname;
    } catch {
      res.writeHead(400, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ error: 'URL inválida.' }));
      return;
    }

    // 3. Rotas da API
    if (pathname.startsWith('/api/') || pathname === '/api') {
      if (pathname === '/api/health') {
        handleHealthRequest(req, res);
        return;
      }

      if (pathname === '/api/privacy') {
        handlePrivacyRequest(req, res);
        return;
      }

      if (pathname === '/api/doctor') {
        // T5a: só configuração declarada; raiz do projeto = cwd, como em index.ts (createVoiceRuntime).
        handleDoctorRequest(req, res, process.cwd());
        return;
      }

      if (pathname === '/api/usage') {
        handleUsageRequest(req, res, voiceDeps?.usageSummary as (() => UsageStatus) | undefined);
        return;
      }

      if (pathname.startsWith('/api/ogra/')) {
        if (!voiceDeps) {
          res.writeHead(503, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          });
          res.end(
            JSON.stringify({
              error: 'Voz local indisponível: rode "npm run setup:voice" para configurar o ambiente Python e baixar os modelos.'
            })
          );
          return;
        }
        void handleOgraRoute(req, res, pathname, voiceDeps);
        return;
      }

      if (pathname.startsWith('/api/voice/')) {
        if (!voiceDeps) {
          res.writeHead(503, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          });
          res.end(
            JSON.stringify({
              error: 'Voz local indisponível: rode "npm run setup:voice" para configurar o ambiente Python e baixar os modelos.'
            })
          );
          return;
        }
        void handleVoiceRoute(req, res, pathname, voiceDeps);
        return;
      }

      // Qualquer outra rota de API não encontrada DEVE retornar JSON 404, nunca HTML
      res.writeHead(404, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ error: 'Rota de API não encontrada.' }));
      return;
    }

    // 4. Servir arquivos estáticos do frontend (para npm start na mesma origem)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Método não permitido');
      return;
    }

    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    let targetFile = path.join(staticDir, safePath);

    // Se for diretório ou raiz, apontar para index.html
    if (fs.existsSync(targetFile) && fs.statSync(targetFile).isDirectory()) {
      targetFile = path.join(targetFile, 'index.html');
    }

    // Prevenção de Path Traversal
    if (!targetFile.startsWith(staticDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Acesso proibido');
      return;
    }

    if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
      const ext = path.extname(targetFile).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff'
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        fs.createReadStream(targetFile).pipe(res);
      }
      return;
    }

    // SPA Fallback para index.html caso exista
    const fallbackIndex = path.join(staticDir, 'index.html');
    if (fs.existsSync(fallbackIndex)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        fs.createReadStream(fallbackIndex).pipe(res);
      }
      return;
    }

    // Se nem o arquivo nem index.html existirem (ex.: antes do build)
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Página não encontrada.');
  };
}

export function startServer(
  config: AppConfig,
  clientDistDir?: string,
  voiceDeps?: VoiceRouteDeps
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const handler = createRequestHandler(config, clientDistDir, voiceDeps);
    const server = http.createServer(handler);

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        const message = `Erro de ocupação de porta: A porta ${config.port} já está em uso em ${config.host}. Encerre o processo anterior ou configure outra porta via PORT.`;
        console.error(message);
        reject(new Error(message));
      } else {
        reject(err);
      }
    });

    server.listen(config.port, config.host, () => {
      console.log(`[Rodrigo AI] Servidor ouvindo exclusivamente em http://${config.host}:${config.port}`);
      resolve(server);
    });
  });
}
