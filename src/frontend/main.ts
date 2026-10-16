import type { HealthResponse, PrivacyStatus, TtsStatus, UsageStatus } from '../shared/types.ts';
import { describePrivacy, describeTtsStatus, PRIVACY_UNAVAILABLE_TEXT, PRIVACY_FOOTNOTE } from '../shared/privacyText.ts';
import { VoiceController } from './voice.ts';

// Ponte de logs para o processo desktop nativo (macOS WKWebView)
const _postToNative = (level: string, ...args: any[]) => {
  try {
    const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    (window as any).webkit?.messageHandlers?.consoleLog?.postMessage(`[web:${level}] ${text}`);
  } catch {}
};
const _origLog = console.log;
console.log = (...args: any[]) => { _origLog(...args); _postToNative('log', ...args); };
const _origWarn = console.warn;
console.warn = (...args: any[]) => { _origWarn(...args); _postToNative('warn', ...args); };
const _origError = console.error;
console.error = (...args: any[]) => { _origError(...args); _postToNative('err', ...args); };

// Elementos da interface do usuário
const statusContainer = document.getElementById('health-status-container') as HTMLDivElement;
const statusMessage = document.getElementById('health-message') as HTMLSpanElement;
const detailsContainer = document.getElementById('health-details') as HTMLDivElement;
const serverStatusSpan = document.getElementById('server-status') as HTMLSpanElement;
const serverVersionSpan = document.getElementById('server-version') as HTMLSpanElement;
const retryButton = document.getElementById('retry-btn') as HTMLButtonElement;

// Controle de concorrência para evitar chamadas simultâneas
let isChecking = false;

/**
 * Atualiza o status visual e acessível (via role="status" e aria-live="polite").
 */
function setStatus(
  type: 'loading' | 'connected' | 'error',
  message: string,
  details?: { status: string; version: string }
): void {
  statusContainer.className = `status-indicator ${type}`;
  statusMessage.textContent = message;

  if (type === 'connected' && details) {
    detailsContainer.hidden = false;
    serverStatusSpan.textContent = details.status;
    serverVersionSpan.textContent = details.version;
  } else {
    detailsContainer.hidden = true;
    serverStatusSpan.textContent = '-';
    serverVersionSpan.textContent = '-';
  }
}

/**
 * Traduz mensagens de erro de rede para português simples, sem expor mensagens em inglês como "Failed to fetch".
 */
function formatPortugueseErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'Tempo limite de resposta (5s) esgotado aguardando o sistema local.';
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('failed') || msg.includes('load failed')) {
      return 'Não foi possível conectar ao sistema neste computador. Verifique se o serviço está em execução.';
    }
    return error.message;
  }

  return 'Ocorreu uma falha inesperada ao comunicar com o sistema local.';
}

/**
 * Executa a verificação real da saúde do sistema local.
 * Mantém o timeout ativo durante toda a requisição e leitura do corpo JSON.
 */
async function checkHealth(): Promise<void> {
  // Prevenir requisições concorrentes
  if (isChecking) {
    return;
  }

  isChecking = true;
  retryButton.disabled = true;
  setStatus('loading', 'Verificando conexão com o sistema neste computador...');

  const controller = new AbortController();
  let timeoutId: number | undefined;

  try {
    timeoutId = window.setTimeout(() => {
      controller.abort();
    }, 5000);

    const response = await fetch('/api/health', {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`O sistema retornou uma resposta inesperada (código ${response.status}).`);
    }

    // Leitura e parse do JSON protegidos pelo mesmo timeout
    const data = (await response.json()) as HealthResponse;

    if (data && data.status === 'ok' && data.version === '0.3.0') {
      setStatus('connected', 'Tudo pronto neste computador. O sistema está conectado e respondendo normalmente.', {
        status: 'Ativo',
        version: data.version
      });
    } else {
      throw new Error('Formato de resposta do sistema não reconhecido.');
    }
  } catch (error: unknown) {
    const friendlyError = formatPortugueseErrorMessage(error);
    setStatus('error', `Falha de conexão: ${friendlyError} Clique em "Tentar novamente".`);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
    isChecking = false;
    retryButton.disabled = false;
  }
}

// Vinculação de eventos
retryButton.addEventListener('click', () => {
  checkHealth();
});

const closePanelBtn = document.getElementById('close-panel-btn') as HTMLButtonElement | null;
if (closePanelBtn) {
  closePanelBtn.addEventListener('click', () => {
    try {
      (window as any).webkit?.messageHandlers?.closePanel?.postMessage('close');
    } catch {
      window.close();
    }
  });
}

const minimizePanelBtn = document.getElementById('minimize-panel-btn') as HTMLButtonElement | null;
if (minimizePanelBtn) {
  minimizePanelBtn.addEventListener('click', () => {
    try {
      (window as any).webkit?.messageHandlers?.minimizePanel?.postMessage('minimize');
    } catch {}
  });
}

// --- Privacidade (Fase 12): lê GET /api/privacy e mostra o que fica local e o que vai ao Gemini ---

function isPrivacyStatus(value: unknown): value is PrivacyStatus {
  const v = value as Partial<PrivacyStatus> | null;
  return (
    !!v &&
    (v.mode === 'cloud' || v.mode === 'local-only') &&
    typeof v.keyPresent === 'boolean' &&
    !!v.sends &&
    typeof v.sends.history === 'boolean' &&
    !!v.tts &&
    typeof v.tts.cloud === 'boolean'
  );
}

function fillList(listId: string, items: string[]): void {
  const list = document.getElementById(listId) as HTMLUListElement;
  list.replaceChildren(
    ...items.map((text) => {
      const li = document.createElement('li');
      li.textContent = text; // textContent: nunca innerHTML com texto derivado de dados
      return li;
    })
  );
}

async function loadPrivacy(): Promise<void> {
  const headline = document.getElementById('privacy-headline') as HTMLParagraphElement;
  const details = document.getElementById('privacy-details') as HTMLDivElement;
  const goesTitle = document.querySelector('#privacy-details h3:nth-of-type(2)') as HTMLElement;
  const footnote = document.getElementById('privacy-footnote') as HTMLParagraphElement;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/api/privacy', { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`código ${response.status}`);
    const data: unknown = await response.json();
    if (!isPrivacyStatus(data)) throw new Error('formato não reconhecido');
    const text = describePrivacy(data);
    headline.textContent = text.headline;
    fillList('privacy-stays', text.stays);
    fillList('privacy-goes', text.goes);
    fillList('privacy-warnings', text.warnings);
    goesTitle.hidden = text.goes.length === 0;
    (document.getElementById('privacy-goes') as HTMLElement).hidden = text.goes.length === 0;
    details.hidden = false;
    footnote.textContent = text.footnote;
  } catch {
    headline.textContent = PRIVACY_UNAVAILABLE_TEXT;
    details.hidden = true;
    footnote.textContent = PRIVACY_FOOTNOTE;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

// --- Estado da voz (Fase 13a): qual voz fala e quanto da cota do dia já foi usada ---
function isTtsStatus(value: unknown): value is TtsStatus {
  const v = value as Partial<TtsStatus> | null;
  return !!v && typeof v.engine === 'string' && typeof v.name === 'string';
}

async function loadTtsStatus(): Promise<void> {
  const el = document.getElementById('tts-status') as HTMLParagraphElement | null;
  if (!el) return;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch('/api/voice/tts-status', { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`código ${response.status}`);
    const data: unknown = await response.json();
    const text = isTtsStatus(data) ? describeTtsStatus(data) : null;
    el.textContent = text ?? '';
    el.hidden = text === null;
  } catch {
    el.hidden = true; // voz indisponível (503) ou sem resposta: some em vez de mostrar um número velho
  } finally {
    window.clearTimeout(timeoutId);
  }
}

// --- Uso hoje: gasto PRÓPRIO com o Gemini (GET /api/usage, só números agregados) ---

const USAGE_SOURCE_NAMES: Record<string, string> = {
  geracao: 'Respostas',
  intencao: 'Intenções',
  visao: 'Tela (nuvem)',
  tts: 'Voz'
};

function isUsageStatus(value: unknown): value is UsageStatus {
  const v = value as Partial<UsageStatus> | null;
  return (
    !!v &&
    typeof v.day === 'string' &&
    typeof v.resetInMs === 'number' &&
    Array.isArray(v.models) &&
    v.models.every(
      (m) =>
        !!m &&
        typeof (m as { source?: unknown }).source === 'string' &&
        typeof (m as { model?: unknown }).model === 'string' &&
        typeof (m as { req?: unknown }).req === 'number' &&
        typeof (m as { pct?: unknown }).pct === 'number'
    )
  );
}

function formatResetIn(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}min` : `${m}min`;
}

async function loadUsage(): Promise<void> {
  const resetEl = document.getElementById('usage-reset') as HTMLParagraphElement;
  const rowsEl = document.getElementById('usage-rows') as HTMLDivElement;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/api/usage', { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`código ${response.status}`);
    const data: unknown = await response.json();
    if (!isUsageStatus(data)) throw new Error('formato não reconhecido');
    resetEl.textContent = `Zera em ${formatResetIn(data.resetInMs)}.`;
    rowsEl.replaceChildren();
    if (data.models.length === 0) {
      const p = document.createElement('p');
      p.className = 'cost-note';
      p.textContent = 'Nenhuma chamada ao Gemini hoje — tudo local, custo zero.';
      rowsEl.appendChild(p);
      return;
    }
    for (const row of data.models) {
      const pct = Math.max(0, Math.min(1, row.pct));
      const wrap = document.createElement('div');
      wrap.className = 'usage-row';
      const label = document.createElement('div');
      label.className = 'usage-label';
      const name = document.createElement('span');
      name.textContent = `${USAGE_SOURCE_NAMES[row.source] ?? row.source} · ${row.model}`;
      const nums = document.createElement('span');
      nums.className = 'usage-nums';
      const tokens = row.inTokens + row.outTokens;
      nums.textContent = `${Math.round(pct * 100)}% · ${row.req} req · ${tokens.toLocaleString('pt-BR')} tok (teto ${row.cap}/dia)`;
      label.append(name, nums);
      const bar = document.createElement('div');
      bar.className = 'usage-bar';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      const fill = document.createElement('div');
      fill.className = 'usage-fill' + (pct >= 1 ? ' usage-fill-full' : '');
      fill.style.width = `${Math.round(pct * 100)}%`;
      bar.appendChild(fill);
      wrap.append(label, bar);
      rowsEl.appendChild(wrap);
    }
  } catch {
    resetEl.textContent = 'Gasto do dia indisponível (voz local desligada ou sem resposta).';
    rowsEl.replaceChildren();
  } finally {
    window.clearTimeout(timeoutId);
  }
}
// Verificação inicial ao carregar a página
document.addEventListener('DOMContentLoaded', () => {
  checkHealth();
  void loadPrivacy();
  void loadTtsStatus();
  void loadUsage();
  window.setInterval(() => void loadTtsStatus(), 15_000);
  window.setInterval(() => void loadUsage(), 60_000);
});

// --- Conversa por Voz (Fase 2) ---

const voiceStateContainer = document.getElementById('voice-state') as HTMLDivElement;
const voiceStateText = document.getElementById('voice-state-text') as HTMLSpanElement;
const voiceStartBtn = document.getElementById('voice-start-btn') as HTMLButtonElement;
const voiceEndBtn = document.getElementById('voice-end-btn') as HTMLButtonElement;
const voiceMuteBtn = document.getElementById('voice-mute-btn') as HTMLButtonElement;
const voiceInterruptBtn = document.getElementById('voice-interrupt-btn') as HTMLButtonElement;
const voiceScreenBtn = document.getElementById('voice-screen-btn') as HTMLButtonElement;
const voiceScreenNote = document.getElementById('voice-screen-note') as HTMLParagraphElement;
const voiceTranscriptLog = document.getElementById('voice-transcript-log') as HTMLDivElement;
const voiceAgentIndicator = document.getElementById('voice-agent-indicator') as HTMLSpanElement;

const VOICE_STATE_LABELS: Record<string, string> = {
  idle: 'Parado — clique em "Iniciar conversa" para começar.',
  ouvindo: 'Ouvindo — pode falar.',
  processando: 'Processando sua fala...',
  falando: 'Rodrigo AI está respondendo...',
  aquecendo: 'Aquecendo os modelos locais (pode levar até 2 minutos na primeira vez)...',
  erro: 'Ocorreu um erro. Veja a mensagem no log abaixo.'
};

const ORCHESTRATOR_LABEL_NAMES: Record<string, string> = {
  GERAL: 'Geral',
  TEOLOGIA: 'Teologia',
  VIRTOLOGIA: 'Virtologia',
  NEUROCIENCIA: 'Neurociência',
  AMBIGUO: 'Ambiguidade',
  TELA: 'Tela'
};

let muted = false;

/**
 * O indicador de agente é resetado a cada novo turno ("processando"), erro, ou fim de
 * sessão — nunca mostra o rótulo de um turno que não é mais o atual (Achado 9 da
 * auditoria). Como a sessão só processa um turno por vez (o anterior é sempre cancelado
 * antes de "processando" disparar de novo), esse reset por estado já é suficiente sem
 * precisar rastrear turnId independentemente aqui.
 */
function resetAgentIndicator(): void {
  voiceAgentIndicator.textContent = '';
}

function appendTranscriptEntry(speaker: 'Você' | 'Rodrigo AI', text: string): void {
  const entry = document.createElement('p');
  entry.className = 'transcript-entry';
  const strong = document.createElement('strong');
  strong.textContent = `${speaker}: `;
  entry.appendChild(strong);
  entry.appendChild(document.createTextNode(text));
  voiceTranscriptLog.appendChild(entry);
  voiceTranscriptLog.scrollTop = voiceTranscriptLog.scrollHeight;
}

function appendErrorEntry(message: string): void {
  const entry = document.createElement('p');
  entry.className = 'transcript-entry transcript-error';
  entry.textContent = `Erro: ${message}`;
  voiceTranscriptLog.appendChild(entry);
  voiceTranscriptLog.scrollTop = voiceTranscriptLog.scrollHeight;
}

function appendNoticeEntry(message: string): void {
  const entry = document.createElement('p');
  entry.className = 'transcript-entry transcript-notice';
  entry.textContent = `Aviso: ${message}`;
  voiceTranscriptLog.appendChild(entry);
  voiceTranscriptLog.scrollTop = voiceTranscriptLog.scrollHeight;
}

const voiceController = new VoiceController(
  (state) => {
    voiceStateContainer.className = `voice-state voice-state-${state}`;
    voiceStateText.textContent = VOICE_STATE_LABELS[state] || state;
    voiceInterruptBtn.disabled = state !== 'falando';
    // Novo turno começando (processando) ou erro: o rótulo do turno anterior não vale mais.
    if (state === 'processando' || state === 'erro') {
      resetAgentIndicator();
    }
    const effectiveState = muted ? 'mutado' : state;
    (window as any).webkit?.messageHandlers?.iconState?.postMessage(effectiveState);
  },
  (text) => appendTranscriptEntry('Você', text),
  (text) => appendTranscriptEntry('Rodrigo AI', text),
  (message) => appendErrorEntry(message),
  (_turnId, label, _handled) => {
    // Checa o rótulo explicitamente (não `handled`) — `!handled` sozinho não garante
    // que o rótulo é AMBIGUO, e presumir isso podia exibir texto enganoso se algum dia
    // deixasse de valer. `handled` não é mais lido aqui (Fase 4: GERAL/TEOLOGIA/VIRTOLOGIA
    // já são todos `handled: true`) — renomeado para `_handled` como `_turnId` acima.
    const name = ORCHESTRATOR_LABEL_NAMES[label] || label;
    voiceAgentIndicator.textContent =
      label === 'AMBIGUO' ? 'Classificado como: AMBÍGUO (respondido pelo agente Geral)' : `Agente: ${name}`;
  },
  (sharing) => {
    voiceScreenBtn.setAttribute('aria-pressed', String(sharing));
    voiceScreenBtn.textContent = sharing ? 'Parar compartilhamento' : 'Compartilhar tela';
    voiceScreenNote.hidden = !sharing;
  },
  (message) => appendNoticeEntry(message)
);

voiceStartBtn.addEventListener('click', () => {
  void (async () => {
    voiceStartBtn.disabled = true;
    try {
      await voiceController.start();
      voiceEndBtn.disabled = false;
      voiceMuteBtn.disabled = false;
      voiceScreenBtn.disabled = false;
    } catch (error) {
      appendErrorEntry(formatPortugueseErrorMessage(error));
      voiceStartBtn.disabled = false;
    }
  })();
});

voiceEndBtn.addEventListener('click', () => {
  void (async () => {
    await voiceController.stop();
    voiceStartBtn.disabled = false;
    voiceEndBtn.disabled = true;
    voiceMuteBtn.disabled = true;
    voiceInterruptBtn.disabled = true;
    voiceScreenBtn.disabled = true;
    muted = false;
    voiceMuteBtn.setAttribute('aria-pressed', 'false');
    voiceMuteBtn.textContent = 'Silenciar microfone';
    resetAgentIndicator();
  })();
});

voiceMuteBtn.addEventListener('click', () => {
  muted = !muted;
  voiceController.muteMicrophone(muted);
  voiceMuteBtn.setAttribute('aria-pressed', String(muted));
  voiceMuteBtn.textContent = muted ? 'Reativar microfone' : 'Silenciar microfone';
});

voiceInterruptBtn.addEventListener('click', () => {
  voiceController.interruptManually();
});

voiceScreenBtn.addEventListener('click', () => {
  void (async () => {
    if (voiceController.isSharingScreen) {
      voiceController.stopSharingScreen();
      return;
    }
    try {
      await voiceController.shareScreen();
    } catch (error) {
      appendErrorEntry(formatPortugueseErrorMessage(error));
    }
  })();
});

window.addEventListener('beforeunload', () => {
  void voiceController.stop();
});

// Exposed for native Swift desktop app via callAsyncJavaScript
(window as any).__startVoice = async (): Promise<string> => {
  try {
    if (!voiceEndBtn.disabled) return 'already_active';
    voiceStartBtn.disabled = true;
    await voiceController.start();
    voiceEndBtn.disabled = false;
    voiceMuteBtn.disabled = false;
    voiceScreenBtn.disabled = false;
    (window as any).webkit?.messageHandlers?.iconState?.postMessage('ouvindo');
    return 'started';
  } catch (e) {
    voiceStartBtn.disabled = false;
    (window as any).webkit?.messageHandlers?.iconState?.postMessage('idle');
    return 'error:' + (e instanceof Error ? e.message : String(e));
  }
};

(window as any).__stopVoice = async (): Promise<string> => {
  try {
    await voiceController.stop();
    voiceStartBtn.disabled = false;
    voiceEndBtn.disabled = true;
    voiceMuteBtn.disabled = true;
    voiceInterruptBtn.disabled = true;
    voiceScreenBtn.disabled = true;
    muted = false;
    voiceMuteBtn.setAttribute('aria-pressed', 'false');
    voiceMuteBtn.textContent = 'Silenciar microfone';
    resetAgentIndicator();
    (window as any).webkit?.messageHandlers?.iconState?.postMessage('idle');
    return 'stopped';
  } catch (e) {
    return 'error:' + (e instanceof Error ? e.message : String(e));
  }
};

(window as any).__toggleMute = async (): Promise<string> => {
  try {
    const vs = voiceController.getState();
    if (vs === 'idle' || vs === 'erro') return 'not_active';
    muted = !muted;
    voiceController.muteMicrophone(muted);
    voiceMuteBtn.setAttribute('aria-pressed', String(muted));
    voiceMuteBtn.textContent = muted ? 'Reativar microfone' : 'Silenciar microfone';
    const stateToSend = muted ? 'mutado' : voiceController.getState();
    (window as any).webkit?.messageHandlers?.iconState?.postMessage(stateToSend);
    return muted ? 'muted' : 'unmuted';
  } catch (e) {
    return 'error:' + (e instanceof Error ? e.message : String(e));
  }
};

(window as any).__toggleVoice = async (): Promise<string> => {
  if (!voiceEndBtn.disabled) {
    return (window as any).__stopVoice();
  }
  return (window as any).__startVoice();
};
