import type { IncomingMessage, ServerResponse } from 'node:http';
import { effectivePrivacy } from '../privacy.js';
import { getOutboundCounts } from '../privacy/outboundGuard.js';

/**
 * Rota GET /api/privacy (Fase 12). A validação de Host já ocorreu em server.ts, antes do roteamento,
 * igual a /api/health. Resposta sem segredos (docs/phase-12-v2.md §2.2).
 */
export function handlePrivacyRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'application/json; charset=utf-8',
      Allow: 'GET, HEAD',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ error: 'Método não permitido' }));
    return;
  }

  let payload: string;
  try {
    payload = JSON.stringify({ ...effectivePrivacy(process.env), outboundGuardCounts: getOutboundCounts() });
  } catch (err) {
    // Configuração inválida normalmente já derrubou o startup; se chegar aqui, não escondemos.
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Configuração de privacidade inválida.' }));
    return;
  }

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
