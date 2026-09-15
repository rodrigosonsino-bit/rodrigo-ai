import { loadConfig } from './config.js';
import { startServer } from './server.js';
import { createVoiceRuntime } from './voice/voiceRuntime.js';

try {
  const config = loadConfig();
  const voiceRuntime = createVoiceRuntime(process.cwd());

  if (voiceRuntime.available) {
    console.log('[Rodrigo AI] Voz local disponível (worker MLX inicializando em segundo plano).');
  } else {
    console.log(`[Rodrigo AI] Voz local indisponível: ${voiceRuntime.reason}`);
  }

  const server = await startServer(
    config,
    undefined,
    voiceRuntime.available
      ? { config, sessionManager: voiceRuntime.sessionManager!, audioStore: voiceRuntime.audioStore! }
      : undefined
  );

  let shuttingDown = false;

  // Correção 10 (Fase 2): o worker Python e os arquivos temporários de áudio são
  // encerrados/limpos ANTES de fechar o servidor HTTP, com a mesma garantia de
  // "sem processos órfãos" que a Fase 1 já tinha só para o próprio servidor.
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[Rodrigo AI] Encerrando servidor HTTP limpo...');

    void voiceRuntime
      .shutdown()
      .catch((err) => console.error('[Rodrigo AI] Erro ao encerrar runtime de voz:', err))
      .finally(() => {
        // server.close() sozinho espera conexões abertas (ex.: SSE de uma sessão de voz
        // ainda conectada no navegador) fecharem por conta própria — closeAllConnections()
        // evita que um Ctrl+C trave esperando uma aba que o usuário nem fechou.
        server.close((err) => {
          if (err) {
            console.error('[Rodrigo AI] Erro ao encerrar servidor:', err);
            process.exit(1);
          }
          console.log('[Rodrigo AI] Servidor encerrado sem processos órfãos.');
          process.exit(0);
        });
        server.closeAllConnections();
        server.closeIdleConnections();
      });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error('[Rodrigo AI] Falha na inicialização:', error instanceof Error ? error.message : error);
  process.exit(1);
}
