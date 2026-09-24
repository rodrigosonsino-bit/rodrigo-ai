import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface StoredItem {
  id: string;
  text: string;
  createdAt: string;
  dueAt?: string | null;      // NOVO — ISO 8601, preenchido quando há agendamento; NotaTool nunca escreve.
  notifiedAt?: string | null; // NOVO — ISO 8601, preenchido SOMENTE após o disparo bem-sucedido da notificação.
}

export class JsonStore<T = StoredItem> {
  private readonly filePath: string;

  /**
   * baseDir é OBRIGATÓRIO — mesmo padrão de AudioStore (audioStore.ts:14-16). Produção
   * recebe data/ real (voiceRuntime.ts); testes recebem fs.mkdtempSync(), nunca escrevem
   * no diretório real do projeto (achado 6 da rodada 2).
   */
  constructor(baseDir: string, fileName: string) {
    fs.mkdirSync(baseDir, { recursive: true });
    this.filePath = path.join(baseDir, fileName);
  }

  read(): { items: T[] } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      // Achado 2 (ALTA, v4) — só ausência de arquivo é "vazio de verdade". Qualquer outro
      // erro (permissão, I/O) propaga: fingir vazio aqui faria a próxima escrita
      // sobrescrever dado que só está temporariamente ilegível, não perdido.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { items: [] };
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Arquivo de dados corrompido (JSON inválido): ${this.filePath}`);
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as { items?: unknown }).items)
    ) {
      throw new Error(`Arquivo de dados corrompido (formato inesperado): ${this.filePath}`);
    }

    return parsed as { items: T[] };
  }

  write(data: { items: T[] }): void {
    const tmp = `${this.filePath}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath); // atômico no mesmo filesystem — v1 §4.5
  }
}
