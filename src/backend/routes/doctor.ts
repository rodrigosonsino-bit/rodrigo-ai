import type { IncomingMessage, ServerResponse } from 'node:http';
import { runDoctor } from '../doctor.js';

/**
 * Rota GET /api/doctor (T5a). A validação de Host/Origin já ocorreu em server.ts, antes do roteamento,
 * igual a /api/health e /api/privacy. O relatório só contém nomes, booleanos e enumerações (ver doctor.ts).
 */
export function handleDoctorRequest(req: IncomingMessage, res: ServerResponse, rootDir: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'application/json; charset=utf-8',
      Allow: 'GET, HEAD',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ error: 'Método não permitido' }));
    return;
  }

  const payload = JSON.stringify(runDoctor({ env: process.env, rootDir }));
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
