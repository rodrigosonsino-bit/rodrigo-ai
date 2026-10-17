import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import type { AppConfig } from '../../shared/types.js';
import { VOICE_LIMITS } from '../../shared/voiceProtocol.js';
import type { AudioStore } from './audioStore.js';
import type { SessionManager } from './sessionManager.js';
import { parseWavHeader } from './wav.js';
import { parseJpegHeader } from './image.js';
import { ograCallbackAuthorized } from '../agents/ograCallbackAuth.js';

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
  /** Uso próprio do Gemini (GET /api/usage). Só números; nenhum texto de conversa. */
  usageSummary?: () => unknown;
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

  // Fase V Fatia 5: entrada textual (digitação) — fallback quando a voz falha. O texto vai pelo
  // MESMO pipeline que a voz (intenção, mutação, classificação, geração); a única diferença é que
  // pula a transcrição e o `hasRecognizableSpeech` (o texto já é confiável). O `origin` é 'normal',
  // nunca 'screen': um texto digitado não é pergunta de tela mesmo que cite "tela"/"monitor".
  if (pathname === '/api/voice/session/text' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readJsonBody(req, VOICE_LIMITS.MAX_TEXT_CHARS + 1024)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'JSON inválido.' });
      return true;
    }
    const text = String(body.text || '');
    if (!text.trim()) {
      sendJson(res, 400, { error: 'Texto vazio.' });
      return true;
    }
    if (text.length > VOICE_LIMITS.MAX_TEXT_CHARS) {
      sendJson(res, 400, { error: `Texto excede o limite de ${VOICE_LIMITS.MAX_TEXT_CHARS} caracteres.` });
      return true;
    }
    // submitText é async: sem await a resposta virava `{}` e o status ignorava erro de sessão.
    const result = await deps.sessionManager.submitText(sessionId, token, text);
    sendJson(res, 'error' in result ? 401 : 200, result);
    return true;
  }

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

  // Fase V (§4): captura de tela de uso único. Dois formatos de corpo: JSON {captureId, unavailable:true} quando o
  // navegador não tem compartilhamento ativo, ou binário JPEG (?captureId=...) com o quadro capturado.
  if (pathname === '/api/voice/session/screen' && req.method === 'POST') {
    const captureId = url.searchParams.get('captureId') || '';
    const contentType = String(req.headers['content-type'] || '');

    if (contentType.includes('application/json')) {
      let body: Record<string, unknown>;
      try {
        body = (await readJsonBody(req, 4096)) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: 'JSON inválido.' });
        return true;
      }
      // Auditoria Kimi K3 (fatia 3, achado 5): o captureId vem SÓ do corpo JSON aqui — nunca misturar com a query,
      // que é a fonte do ramo binário; evita consumir um pedido diferente do que o cliente pretendia.
      const cid = String(body.captureId || '');
      const ok = deps.sessionManager.rejectScreenCapture(sessionId, token, cid);
      sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'Pedido de captura inválido, vencido ou já atendido.' });
      return true;
    }

    // Corpo binário: valida sessão/captureId ANTES de alocar qualquer armazenamento em disco (achado 7 da auditoria
    // da Fase V — nunca escrever a favor de uma sessão inválida/encerrada).
    if (!captureId || !deps.sessionManager.screenCaptureExpected(sessionId, token, captureId)) {
      sendJson(res, 409, { error: 'Pedido de captura inválido, vencido ou já atendido.' });
      return true;
    }

    let bodyBuffer: Buffer;
    try {
      bodyBuffer = await readBinaryBody(req, VOICE_LIMITS.MAX_SCREEN_IMAGE_BYTES);
    } catch {
      sendJson(res, 413, { error: 'Imagem excede o limite de tamanho permitido.' });
      res.once('finish', () => req.destroy());
      return true;
    }

    const jpeg = parseJpegHeader(bodyBuffer);
    if (!jpeg) {
      sendJson(res, 400, { error: 'Imagem inválida: esperado JPEG válido.' });
      return true;
    }
    if (jpeg.width > VOICE_LIMITS.MAX_SCREEN_IMAGE_DIM || jpeg.height > VOICE_LIMITS.MAX_SCREEN_IMAGE_DIM) {
      sendJson(res, 400, { error: `Imagem excede ${VOICE_LIMITS.MAX_SCREEN_IMAGE_DIM}px no maior lado.` });
      return true;
    }

    const filePath = deps.audioStore.newScreenCapturePath(sessionId);
    // Auditoria Kimi K3 (fatia 3, achado 1): gravar e consumir precisam de try/finally — sem isso, uma exceção aqui
    // (disco cheio, permissão) deixava o JPEG em disco para sempre E o pedido de captura nunca resolvia (o turno
    // só liberaria depois do prazo inteiro). Qualquer exceção agora apaga o arquivo, rejeita o pedido explicitamente
    // (destrava o turno na hora, em vez de esperar o timeout) e sobe para o catch genérico do servidor.
    try {
      await fs.promises.writeFile(filePath, bodyBuffer);
      // Revalida DEPOIS de gravar (§4): o turno pode ter sido cancelado enquanto o corpo chegava pela rede.
      const accepted = deps.sessionManager.receiveScreenCapture(sessionId, token, captureId, filePath, bodyBuffer.byteLength);
      if (!accepted) {
        await fs.promises.rm(filePath, { force: true }).catch((e) => console.warn('[screen] falha ao remover captura rejeitada', filePath, e));
        sendJson(res, 409, { error: 'Pedido de captura inválido, vencido, de outro turno ou já atendido.' });
        return true;
      }
    } catch (err) {
      // Nunca deixar a exceção subir sem resposta: o handler não tem um catch acima (server.ts chama
      // handleVoiceRoute com `void`), e sem isto o cliente ficaria esperando o request para sempre.
      await fs.promises.rm(filePath, { force: true }).catch((e) => console.warn('[screen] falha ao remover captura após erro', filePath, e));
      deps.sessionManager.rejectScreenCapture(sessionId, token, captureId); // destrava o turno na hora, não espera o timeout
      console.error('[screen] falha ao processar captura:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Falha ao processar a captura da tela.' });
      return true;
    }
    sendJson(res, 200, { ok: true });
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

const OGRA_BODY_MAX = 16 * 1024;

/**
 * POST /api/ogra/reply e /api/ogra/tool.
 * Host já foi validado em server.ts. Com RODRIGO_OGRA=0 a rota responde 404,
 * o mesmo de uma rota que não existe. O token é RODRIGO_OGRA_CALLBACK_TOKEN.
 */
export async function handleOgraRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: VoiceRouteDeps
): Promise<boolean> {
  if (!pathname.startsWith('/api/ogra/')) return false;

  if (!deps.sessionManager.ograEnabled) {
    sendJson(res, 404, { error: 'Rota de API não encontrada.' });
    return true;
  }

  if (!isAllowedOrigin(req, deps.config)) {
    sendJson(res, 403, { error: 'Origin não autorizada.' });
    return true;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Método não permitido.' });
    return true;
  }

  if (!ograCallbackAuthorized(req.headers.authorization)) {
    sendJson(res, 401, { error: 'Token do callback recusado.' });
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req, OGRA_BODY_MAX)) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'JSON inválido.' });
    return true;
  }

  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
  if (!taskId || taskId.length > 80 || !/^[A-Za-z0-9_.:-]+$/.test(taskId)) {
    sendJson(res, 400, { error: 'taskId inválido.' });
    return true;
  }

  if (pathname === '/api/ogra/reply') {
    if (typeof body.text !== 'string' || body.text.length > 8000) {
      sendJson(res, 400, { error: 'Texto da resposta inválido.' });
      return true;
    }
    if (typeof body.final !== 'boolean') {
      sendJson(res, 400, { error: 'Campo final deve ser booleano.' });
      return true;
    }
    const result = await deps.sessionManager.consumeOgraReply({ taskId, text: body.text, final: body.final });
    sendJson(res, result.status, result.ok ? { ok: true } : { error: result.error });
    return true;
  }

  if (pathname === '/api/ogra/tool') {
    if (typeof body.tool !== 'string' || !body.tool.trim() || body.tool.length > 80) {
      sendJson(res, 400, { error: 'Ferramenta inválida.' });
      return true;
    }
    const result = await deps.sessionManager.proposeOgraTool({ taskId, tool: body.tool, args: body.args });
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    if (result.kind === 'confirmation_required') {
      sendJson(res, result.status, { ok: true, kind: result.kind, question: result.question });
      return true;
    }
    sendJson(res, result.status, { ok: true, kind: result.kind, output: result.output });
    return true;
  }

  sendJson(res, 404, { error: 'Rota de API não encontrada.' });
  return true;
}
