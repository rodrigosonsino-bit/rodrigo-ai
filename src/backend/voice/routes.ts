import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import type { AppConfig } from '../../shared/types.js';
import { VOICE_LIMITS } from '../../shared/voiceProtocol.js';
import type { AudioStore } from './audioStore.js';
import type { SessionManager } from './sessionManager.js';
import { parseWavHeader } from './wav.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

/**
 * Origin same-origin estrita, além do Host já validado em server.ts. Sem essa checagem,
 * um Host válido não impede um POST cross-origin disparado por outra aba/site (o browser
 * ainda envia o header Origin em requests same-site distintos de subframes/CORS).
 */
function isAllowedOrigin(req: IncomingMessage, config: AppConfig): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // requisições same-origin de navegação direta não enviam Origin
  const allowed = [
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.clientPort}`,
    `http://localhost:${config.clientPort}`
  ];
  return allowed.includes(origin);
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Corpo da requisição excede o limite permitido.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function readBinaryBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let total = 0;
    let rejected = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (rejected) return; // já rejeitado: continua drenando o socket sem acumular mais nada
      total += chunk.length;
      if (total > maxBytes) {
        rejected = true;
        // Não destruir o socket aqui — o cliente ainda está no meio do envio; destruir agora
        // mata a conexão antes que o 413 seja escrito, e o cliente só vê "socket closed".
        // O chamador (handleVoiceRoute) envia a resposta e só então fecha o socket.
        reject(new Error('Áudio excede o limite de tamanho permitido (2 MB).'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

export interface VoiceRouteDeps {
  config: AppConfig;
  sessionManager: SessionManager;
  audioStore: AudioStore;
  /** Fase 13a: estado da voz (GET /api/voice/tts-status). */
  ttsStatus?: () => unknown;
}

/**
 * Roteia /api/voice/*. Retorna true se a rota foi tratada (mesmo com erro), false se
 * o pathname não pertence ao módulo de voz (deixa o chamador continuar o roteamento).
 */
export async function handleVoiceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: VoiceRouteDeps
): Promise<boolean> {
  if (!pathname.startsWith('/api/voice/')) return false;

  if (!isAllowedOrigin(req, deps.config)) {
    sendJson(res, 403, { error: 'Origin não autorizada.' });
    return true;
  }

  const url = new URL(req.url || '/', `http://127.0.0.1:${deps.config.port}`);

  // Fase 13a: estado da voz (motor e orçamento do dia). Só números; nenhum texto de conversa. Sem token: não é dado da sessão.
  if (req.method === 'GET' && url.pathname === '/api/voice/tts-status') {
    sendJson(res, 200, deps.ttsStatus ? deps.ttsStatus() : { engine: 'say', name: 'macOS say', budget: null, counters: null });
    return true;
  }

  if (pathname === '/api/voice/session' && req.method === 'POST') {
    const { sessionId, token } = await deps.sessionManager.createSession();
    sendJson(res, 200, { sessionId, token });
    return true;
  }

  if (pathname === '/api/voice/session/events' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || '';
    const token = url.searchParams.get('token') || '';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const attached = deps.sessionManager.attachEvents(sessionId, token, res);
    if (!attached) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Sessão inválida ou expirada.' })}\n\n`);
      res.end();
    }
    return true;
  }

  // Rotas abaixo exigem sessão identificada via headers (POST, same-origin only).
  const sessionId = (req.headers['x-rodrigo-session'] as string) || '';
  const token = (req.headers['x-rodrigo-token'] as string) || '';

  if (pathname === '/api/voice/session/audio' && req.method === 'POST') {
    let bodyBuffer: Buffer;
    try {
      bodyBuffer = await readBinaryBody(req, VOICE_LIMITS.MAX_AUDIO_BYTES);
    } catch (err) {
      sendJson(res, 413, { error: err instanceof Error ? err.message : 'Áudio inválido.' });
      // Só derruba a conexão depois que a resposta terminou de ser escrita — nunca antes,
      // senão o cliente vê "socket closed" em vez do 413 (o corpo excedente que ainda está
      // chegando é descartado quietamente por readBinaryBody até o socket fechar).
      res.once('finish', () => req.destroy());
      return true;
    }

    const wavInfo = parseWavHeader(bodyBuffer);
    if (!wavInfo) {
      sendJson(res, 400, { error: 'Áudio inválido: esperado WAV PCM válido.' });
      return true;
    }
    if (wavInfo.durationSeconds > VOICE_LIMITS.MAX_AUDIO_SECONDS + 1) {
      sendJson(res, 400, { error: `Áudio excede o limite de ${VOICE_LIMITS.MAX_AUDIO_SECONDS}s.` });
      return true;
    }

    const audioPath = deps.audioStore.newInputPath(sessionId);
    await fs.promises.writeFile(audioPath, bodyBuffer);

    const result = await deps.sessionManager.submitAudio(sessionId, token, audioPath);
    if ('error' in result) {
      sendJson(res, 401, { error: result.error });
      return true;
    }
    sendJson(res, 200, { turnId: result.turnId });
    return true;
  }

  if (pathname === '/api/voice/session/cancel' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readJsonBody(req, 4096)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'JSON inválido.' });
      return true;
    }
    const ok = deps.sessionManager.cancelTurn(sessionId, token, String(body.turnId || ''));
    sendJson(res, ok ? 200 : 401, ok ? { ok: true } : { error: 'Sessão inválida ou expirada.' });
    return true;
  }

  if (pathname === '/api/voice/session/played' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readJsonBody(req, VOICE_LIMITS.MAX_TEXT_CHARS + 1024)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'JSON inválido.' });
      return true;
    }
    const text = String(body.text || '').slice(0, VOICE_LIMITS.MAX_TEXT_CHARS);
    const ok = deps.sessionManager.markPlayed(sessionId, token, String(body.turnId || ''), text);
    sendJson(res, ok ? 200 : 401, ok ? { ok: true } : { error: 'Sessão inválida ou expirada.' });
    return true;
  }

  if (pathname === '/api/voice/session/end' && req.method === 'POST') {
    const ok = await deps.sessionManager.endSession(sessionId, token);
    sendJson(res, ok ? 200 : 401, ok ? { ok: true } : { error: 'Sessão inválida ou expirada.' });
    return true;
  }

  const audioMatch = /^\/api\/voice\/session\/audio\/([0-9a-f-]{36})$/.exec(pathname);
  if (audioMatch && req.method === 'GET') {
    const audioId = audioMatch[1];
    const qSessionId = url.searchParams.get('sessionId') || '';
    const qToken = url.searchParams.get('token') || '';
    const filePath = deps.sessionManager.resolveAudioPath(qSessionId, qToken, audioId);
    if (!filePath || !fs.existsSync(filePath)) {
      sendJson(res, 404, { error: 'Áudio não encontrado.' });
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  sendJson(res, 404, { error: 'Rota de voz não encontrada.' });
  return true;
}
