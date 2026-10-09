import type {
  VoiceServerEvent,
  CreateSessionResponse,
  AudioTurnResponse,
  OrchestratorLabel
} from '../shared/voiceProtocol.ts';

// --- Parâmetros de VAD (Fase 2 v2 + adendo) ---
const PRE_ROLL_MS = 200;
// F13b (decisão do usuário, 2026-10-08: "1,0 s"): 700 ms cortava a pergunta em pausas naturais e cada pedaço virava um turno
// com transcrição ruim. Custo: +0,3 s em toda resposta. A junção de fragmentos no servidor foi reprovada na auditoria
// (docs/phase-13b-v1.md + docs/audits/f13b-plan-codex-2026-10-08.md).
const SILENCE_THRESHOLD_MS = 1000;
const MIN_VOICE_DURATION_MS = 220; // Achado v2-5: 200-250ms, não os 400ms originais (corta "Sim"/"Não"/"Oi")
const MAX_SEGMENT_MS = 20_000;
const BARGE_IN_HYSTERESIS_MS = 250; // sustentar fala acima do limiar por 250ms durante "falando"
const RMS_THRESHOLD = 0.018;
const RMS_THRESHOLD_WHILE_SPEAKING = 0.045; // limiar elevado durante playback (histerese)

type VoiceState = 'idle' | 'ouvindo' | 'processando' | 'falando' | 'aquecendo' | 'erro';

interface QueuedChunk {
  turnId: string;
  sentenceIndex: number;
  audioId: string;
  text: string;
}

export class VoiceController {
  private sessionId: string | null = null;
  private token: string | null = null;
  private eventSource: EventSource | null = null;

  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;

  private state: VoiceState = 'idle';
  private currentTurnId: string | null = null;
  /** Fase V §6: só vale durante 'processando' do turno ATUAL — resetado a cada novo 'processando'/'erro'. */
  private lastRoutingLabel: OrchestratorLabel | null = null;

  // --- Compartilhamento de tela (Fase V) ---
  private screenStream: MediaStream | null = null;
  private screenVideo: HTMLVideoElement | null = null;

  // --- Captura/VAD ---
  private ringBuffer: Float32Array[] = [];
  private ringBufferMs = 0;
  private recording = false;
  private recordedChunks: Float32Array[] = [];
  private recordedMs = 0;
  private continuousVoiceMs = 0;
  private continuousSilenceMs = 0;
  private bargeInCandidateMs = 0;
  private sampleRate = 16000;

  // --- Playback ---
  private playbackQueue: QueuedChunk[] = [];
  private playbackActive = false;
  private currentSource: AudioBufferSourceNode | null = null;
  /**
   * Incrementado SINCRONAMENTE em triggerBargeIn(), antes de source.stop(). O evento
   * onended do Web Audio dispara de forma assíncrona — currentTurnId sozinho não muda
   * nesse momento (só muda quando um turno NOVO começa), então checar só turnId deixa
   * passar uma frase interrompida como se tivesse tocado inteira (achado de consulta ao
   * Codex CLI, 2026-09-29, confirmado por leitura de código). playbackGeneration fecha
   * essa janela porque muda no mesmo instante síncrono do stop(), antes de qualquer
   * continuação assíncrona rodar.
   */
  private playbackGeneration = 0;

  constructor(
    private readonly onStateChange: (state: VoiceState) => void,
    private readonly onTranscript: (text: string) => void,
    private readonly onAssistantText: (text: string) => void,
    private readonly onError: (message: string) => void,
    private readonly onRouting: (turnId: string, label: OrchestratorLabel, handled: boolean) => void,
    private readonly onScreenSharingChange: (sharing: boolean) => void = () => {}
  ) {}

  private setState(state: VoiceState): void {
    this.state = state;
    this.onStateChange(state);
  }

  private headers(): Record<string, string> {
    return {
      'X-Rodrigo-Session': this.sessionId || '',
      'X-Rodrigo-Token': this.token || ''
    };
  }

  async start(): Promise<void> {
    const res = await fetch('/api/voice/session', { method: 'POST', headers: this.headers() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'Erro desconhecido.' }));
      throw new Error(body.error || 'Não foi possível iniciar a sessão de voz.');
    }
    const data = (await res.json()) as CreateSessionResponse;
    this.sessionId = data.sessionId;
    this.token = data.token;

    this.connectEvents();
    await this.startCapture();
    this.setState('ouvindo');
  }

  private connectEvents(): void {
    const url = `/api/voice/session/events?sessionId=${encodeURIComponent(this.sessionId!)}&token=${encodeURIComponent(this.token!)}`;
    const es = new EventSource(url);
    this.eventSource = es;

    es.onmessage = (ev) => {
      let event: VoiceServerEvent;
      try {
        event = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handleServerEvent(event);
    };

    es.onerror = () => {
      // O EventSource tenta reconectar sozinho; se a sessão foi encerrada de verdade,
      // o servidor já fechou a resposta e o navegador para de tentar após alguns erros.
    };
  }

  private handleServerEvent(event: VoiceServerEvent): void {
    switch (event.type) {
      case 'state':
        // Fase V §6: um rótulo de roteamento só vale até o próximo turno recomeçar (mesma lógica que
        // ORCHESTRATOR_LABEL_NAMES em main.ts usa para resetar o indicador visual).
        if (event.state === 'processando' || event.state === 'erro') this.lastRoutingLabel = null;
        this.setState(event.state);
        break;
      case 'transcript':
        this.onTranscript(event.text);
        break;
      case 'routing':
        this.lastRoutingLabel = event.label;
        this.onRouting(event.turnId, event.label, event.handled);
        break;
      case 'screen_request':
        void this.handleScreenRequest(event.captureId);
        break;
      case 'sentence_audio_ready':
        this.playbackQueue.push({
          turnId: event.turnId,
          sentenceIndex: event.sentenceIndex,
          audioId: event.audioId,
          text: event.text
        });
        this.playbackQueue.sort((a, b) => a.sentenceIndex - b.sentenceIndex);
        void this.drainPlaybackQueue();
        break;
      case 'turn_done':
        break;
      case 'session_preempted':
        this.teardown();
        break;
      case 'error':
        this.onError(event.message);
        break;
    }
  }

  // --- Captura de microfone + VAD ---

  private async startCapture(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
    });

    this.audioContext = new AudioContext({ sampleRate: 16000 });
    this.sampleRate = this.audioContext.sampleRate;

    const workletUrl = new URL('./vad-processor.js', import.meta.url);
    await this.audioContext.audioWorklet.addModule(workletUrl);

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.workletNode = new AudioWorkletNode(this.audioContext, 'vad-meter-processor');
    source.connect(this.workletNode);

    this.workletNode.port.onmessage = (ev: MessageEvent<{ rms: number; samples: Float32Array }>) => {
      this.processAudioBlock(ev.data.rms, ev.data.samples);
    };
  }

  private blockDurationMs(samples: Float32Array): number {
    return (samples.length / this.sampleRate) * 1000;
  }

  private pushRing(samples: Float32Array, durationMs: number): void {
    this.ringBuffer.push(samples);
    this.ringBufferMs += durationMs;
    while (this.ringBufferMs > PRE_ROLL_MS && this.ringBuffer.length > 1) {
      const removed = this.ringBuffer.shift()!;
      this.ringBufferMs -= this.blockDurationMs(removed);
    }
  }

  private processAudioBlock(rms: number, samples: Float32Array): void {
    const durationMs = this.blockDurationMs(samples);
    const speaking = this.state === 'falando';
    const threshold = speaking ? RMS_THRESHOLD_WHILE_SPEAKING : RMS_THRESHOLD;
    const isVoice = rms >= threshold;

    if (speaking) {
      // Barge-in: exige fala sustentada acima do limiar elevado por BARGE_IN_HYSTERESIS_MS
      // antes de interromper — evita que o vazamento acústico do próprio TTS no
      // alto-falante dispare autointerrupção (Achado v2-9 + Refinamento do adendo).
      if (isVoice) {
        this.bargeInCandidateMs += durationMs;
        if (this.bargeInCandidateMs >= BARGE_IN_HYSTERESIS_MS) {
          this.triggerBargeIn();
        }
      } else {
        this.bargeInCandidateMs = 0;
      }
      return;
    }

    if (!this.recording) {
      this.pushRing(samples, durationMs);

      if (isVoice) {
        this.continuousVoiceMs += durationMs;
        if (this.continuousVoiceMs >= MIN_VOICE_DURATION_MS) {
          this.beginRecording();
        }
      } else {
        this.continuousVoiceMs = 0;
      }
      return;
    }

    // Gravando o turno atual
    this.recordedChunks.push(samples);
    this.recordedMs += durationMs;

    if (isVoice) {
      this.continuousSilenceMs = 0;
    } else {
      this.continuousSilenceMs += durationMs;
    }

    if (this.continuousSilenceMs >= SILENCE_THRESHOLD_MS || this.recordedMs >= MAX_SEGMENT_MS) {
      void this.finishRecording();
    }
  }

  private beginRecording(): void {
    this.recording = true;
    this.recordedChunks = [...this.ringBuffer];
    this.recordedMs = this.ringBufferMs;
    this.continuousSilenceMs = 0;
    this.continuousVoiceMs = 0;
    this.ringBuffer = [];
    this.ringBufferMs = 0;
  }

  private async finishRecording(): Promise<void> {
    this.recording = false;
    const chunks = this.recordedChunks;
    this.recordedChunks = [];
    this.recordedMs = 0;
    this.continuousSilenceMs = 0;

    const wavBuffer = encodeWavPcm16(chunks, this.sampleRate);
    if (wavBuffer.byteLength === 0) return;

    this.setState('processando');

    try {
      const res = await fetch('/api/voice/session/audio', {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'audio/wav' },
        body: wavBuffer
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Erro ao enviar áudio.' }));
        this.onError(body.error || 'Erro ao enviar áudio.');
        this.setState('ouvindo');
        return;
      }
      const data = (await res.json()) as AudioTurnResponse;
      this.currentTurnId = data.turnId;
    } catch {
      this.onError('Não foi possível enviar o áudio ao sistema local.');
      this.setState('ouvindo');
    }
  }

  // --- Compartilhamento de tela (Fase V §4, §6) ---

  async shareScreen(): Promise<void> {
    if (this.screenStream) return;
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    this.screenStream = stream;
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // alguns navegadores exigem gesto do usuário para tocar; o clique que chamou shareScreen() já é um.
    }
    this.screenVideo = video;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stopSharingScreen());
    this.onScreenSharingChange(true);
  }

  stopSharingScreen(): void {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.screenVideo = null;
    this.onScreenSharingChange(false);
  }

  get isSharingScreen(): boolean {
    return this.screenStream !== null;
  }

  /** Responde ao screen_request do servidor: um quadro atual, reduzido, ou "indisponível" dentro do prazo dele. */
  private async handleScreenRequest(captureId: string): Promise<void> {
    const video = this.screenVideo;
    if (!video || !this.screenStream || video.videoWidth === 0 || video.videoHeight === 0) {
      await this.postScreenUnavailable(captureId);
      return;
    }
    try {
      const maxSide = 1280;
      const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.max(1, Math.round(video.videoWidth * scale));
      const h = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        await this.postScreenUnavailable(captureId);
        return;
      }
      ctx.drawImage(video, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      if (!blob) {
        await this.postScreenUnavailable(captureId);
        return;
      }
      await fetch(`/api/voice/session/screen?captureId=${encodeURIComponent(captureId)}`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'image/jpeg' },
        body: blob
      });
    } catch {
      await this.postScreenUnavailable(captureId).catch(() => {});
    }
  }

  private async postScreenUnavailable(captureId: string): Promise<void> {
    await fetch('/api/voice/session/screen', {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ captureId, unavailable: true })
    }).catch(() => {});
  }

  private triggerBargeIn(): void {
    this.bargeInCandidateMs = 0;
    this.playbackGeneration++;
    this.stopPlaybackImmediately();

    if (this.currentTurnId) {
      void fetch('/api/voice/session/cancel', {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: this.currentTurnId })
      });
    }

    this.playbackQueue = [];
    this.setState('ouvindo');
  }

  // --- Playback ---

  private stopPlaybackImmediately(): void {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        // já pode ter terminado
      }
      this.currentSource = null;
    }
    this.playbackActive = false;
  }

  private async drainPlaybackQueue(): Promise<void> {
    if (this.playbackActive) return;
    this.playbackActive = true;
    const generation = this.playbackGeneration;

    while (this.playbackQueue.length > 0) {
      // Barge-in/teardown durante este drain: este loop ficou obsoleto. Sai sem tocar em
      // playbackActive (stopPlaybackImmediately() já o zerou, e um drain mais novo pode
      // ter assumido) nem na fila (que pode já conter frases de um turno novo). A fila
      // ser esvaziada em triggerBargeIn() deixou de ser a única proteção aqui.
      if (generation !== this.playbackGeneration) return;
      const chunk = this.playbackQueue.shift()!;
      if (chunk.turnId !== this.currentTurnId) continue; // frase de um turno superado

      try {
        await this.playChunk(chunk);
      } catch {
        // erro isolado num chunk não deve travar a fila inteira
      }
    }

    this.playbackActive = false;
  }

  private async playChunk(chunk: QueuedChunk): Promise<void> {
    const generation = this.playbackGeneration;
    const url = `/api/voice/session/audio/${chunk.audioId}?sessionId=${encodeURIComponent(this.sessionId!)}&token=${encodeURIComponent(this.token!)}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const arrayBuffer = await res.arrayBuffer();

    if (!this.audioContext) return;
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

    // chunk.turnId !== currentTurnId cobre um turno NOVO já ter começado; generation
    // cobre um barge-in que ainda não começou um turno novo (ver comentário no campo
    // playbackGeneration acima) — as duas checagens são necessárias, nenhuma sozinha basta.
    if (chunk.turnId !== this.currentTurnId || generation !== this.playbackGeneration) return; // cancelado enquanto decodificava

    await new Promise<void>((resolve) => {
      const source = this.audioContext!.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext!.destination);
      this.currentSource = source;

      source.onended = () => {
        this.currentSource = null;
        resolve();
      };

      source.start();
    });

    if (chunk.turnId !== this.currentTurnId || generation !== this.playbackGeneration) return; // barge-in ocorreu durante a reprodução

    this.onAssistantText(chunk.text);
    void fetch('/api/voice/session/played', {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: chunk.turnId, text: chunk.text })
    });
  }

  interruptManually(): void {
    if (this.state === 'falando') {
      this.triggerBargeIn();
      return;
    }
    // Fase V §6: turno de tela ainda em 'processando' (esperando a captura ou a visão) também pode ser
    // interrompido — é o único rótulo em que "processando" tem uma espera potencialmente longa e sem áudio.
    if (this.state === 'processando' && this.lastRoutingLabel === 'TELA' && this.currentTurnId) {
      void fetch('/api/voice/session/cancel', {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: this.currentTurnId })
      });
      this.setState('ouvindo');
    }
  }

  muteMicrophone(muted: boolean): void {
    this.mediaStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  private teardown(): void {
    this.stopSharingScreen();
    this.playbackGeneration++;
    this.stopPlaybackImmediately();
    this.eventSource?.close();
    this.eventSource = null;
    this.workletNode?.port.close();
    this.workletNode = null;
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    void this.audioContext?.close();
    this.audioContext = null;
    this.sessionId = null;
    this.token = null;
    this.currentTurnId = null;
    this.recording = false;
    this.setState('idle');
  }

  async stop(): Promise<void> {
    if (this.sessionId && this.token) {
      await fetch('/api/voice/session/end', { method: 'POST', headers: this.headers() }).catch(() => {});
    }
    this.teardown();
  }
}

/** Codifica blocos Float32 mono em um WAV PCM 16-bit — sem dependências externas. */
function encodeWavPcm16(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  const totalSamples = chunks.reduce((sum, c) => sum + c.length, 0);
  if (totalSamples === 0) return new ArrayBuffer(0);

  const dataSize = totalSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset: number, str: string): void {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }

  return buffer;
}
