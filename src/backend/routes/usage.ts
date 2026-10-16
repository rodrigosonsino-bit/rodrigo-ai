import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UsageStatus } from '../../shared/types.js';

/**
 * Rota GET /api/usage: gasto PRÓPRIO com o Gemini no dia (livro-caixa local).
 * Sem token de sessão: a resposta só tem números agregados por (fonte, modelo) —
 * nenhum texto de conversa (mesmo racional do tts-status, que também não exige token).
 * Sem runtime de voz, 503 honesto em vez de zeros enganosos.
 */
export function handleUsageRequest(
  req: IncomingMessage,
  res: ServerResponse,
  usageSummary?: () => UsageStatus
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'application/json; charset=utf-8',
      Allow: 'GET, HEAD',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ error: 'Método não permitido' }));
    return;
  }
  if (!usageSummary) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Voz local indisponível: sem runtime, sem medição de uso.' }));
    return;
  }
  const payload = JSON.stringify(usageSummary());
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
