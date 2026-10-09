import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Armazena arquivos temporários de áudio por sessão em diretórios aleatórios privados
 * (Correção 3: nomes via crypto.randomUUID(), nunca derivados de input do usuário).
 * Cada sessão tem seu próprio diretório, apagado inteiro na preempção/encerramento.
 *
 * Fase 12: `baseDir` é o subdiretório DESTE processo (`.runtime/tmp/<pid>-<startEpochMs>/`, ver
 * tmpSweeper.ts) — nunca a base compartilhada, então limpar aqui não afeta outra instância viva.
 */
export class AudioStore {
  private readonly baseDir: string;
  private readonly sessionDirs = new Map<string, string>();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  private dirFor(sessionId: string): string {
    let dir = this.sessionDirs.get(sessionId);
    if (!dir) {
      dir = path.join(this.baseDir, crypto.randomUUID());
      this.sessionDirs.set(sessionId, dir);
    }
    // Fase 12: o cache não prova que a pasta ainda existe (alguém pode tê-la removido) — recria sempre
    // que faltar, em vez de falhar com ENOENT na próxima gravação.
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Caminho de um novo arquivo de áudio de entrada (turno do usuário). */
  newInputPath(sessionId: string): string {
    return path.join(this.dirFor(sessionId), `in-${crypto.randomUUID()}.wav`);
  }

  /** Caminho de um novo arquivo de áudio de saída (frase sintetizada) e seu id público. */
  newOutputPath(sessionId: string): { audioId: string; filePath: string } {
    const audioId = crypto.randomUUID();
    return { audioId, filePath: path.join(this.dirFor(sessionId), `out-${audioId}.wav`) };
  }

  /** Fase V (§4): caminho de um quadro de tela capturado, de uso único (nunca reaproveitado por outro captureId). */
  newScreenCapturePath(sessionId: string): string {
    return path.join(this.dirFor(sessionId), `screen-${crypto.randomUUID()}.jpg`);
  }

  resolveOutputPath(sessionId: string, audioId: string): string | null {
    if (!/^[0-9a-f-]{36}$/.test(audioId)) return null;
    const dir = this.sessionDirs.get(sessionId);
    if (!dir) return null;
    const filePath = path.join(dir, `out-${audioId}.wav`);
    if (!filePath.startsWith(dir)) return null;
    return filePath;
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const dir = this.sessionDirs.get(sessionId);
    this.sessionDirs.delete(sessionId);
    if (!dir) return;
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {
      // limpeza é best-effort
    });
  }

  /** Fase 12: remove o diretório DESTE processo no shutdown gracioso (não recria). */
  async dispose(): Promise<void> {
    this.sessionDirs.clear();
    await fs.promises.rm(this.baseDir, { recursive: true, force: true }).catch(() => {});
  }

  async cleanupAll(): Promise<void> {
    await fs.promises.rm(this.baseDir, { recursive: true, force: true }).catch(() => {});
    fs.mkdirSync(this.baseDir, { recursive: true });
  }
}
