import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HealthResponse } from '../../shared/types.js';

/**
 * Rota GET /api/health
 * Retorna status estrito e versão mínima da aplicação, sem qualquer dado de ambiente ou segredo.
 */
export function handleHealthRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'application/json; charset=utf-8',
      'Allow': 'GET, HEAD',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ error: 'Método não permitido' }));
    return;
  }

  const responseBody: HealthResponse = {
    status: 'ok',
    version: '0.3.0'
  };

  const payload = JSON.stringify(responseBody);

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff'
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  res.end(payload);
}
