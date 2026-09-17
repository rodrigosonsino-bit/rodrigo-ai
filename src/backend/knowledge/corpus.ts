import fs from 'node:fs';
import path from 'node:path';
import { KNOWLEDGE_LIMITS } from '../../shared/voiceProtocol.js';

/** Um trecho consultável do material de referência de um agente. */
export interface KnowledgeChunk {
  agentId: string;
  /** Caminho de cabeçalho legível, ex.: "4. MÉTODO HERMENÊUTICO > 4.2 Sequência obrigatória". */
  headingPath: string;
  body: string;
}

const SOURCES: ReadonlyArray<{ agentId: string; file: string }> = [
  { agentId: 'teologia', file: 'teologia-profile-source.md' },
  { agentId: 'virtologia', file: 'virtologia-profile-source.md' }
];

/**
 * Divide um parágrafo maior que MAX_CHUNK_CHARS: primeiro por fronteira de frase, e uma frase
 * que ainda estoure é fatiada.
 *
 * Invariante: nenhum pedaço devolvido excede MAX_CHUNK_CHARS. O acumulador corrente é fechado
 * ANTES de fatiar — concatená-lo com uma fatia do tamanho do teto produziria um pedaço acima
 * dele (achado real da 5ª auditoria: 1213 chars com teto de 1200).
 */
function hardSplit(paragraph: string): string[] {
  if (paragraph.length <= KNOWLEDGE_LIMITS.MAX_CHUNK_CHARS) return [paragraph];
  const out: string[] = [];
  let current = '';
  for (let sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    while (sentence.length > KNOWLEDGE_LIMITS.MAX_CHUNK_CHARS) {
      if (current.length > 0) {
        out.push(current);
        current = '';
      }
      out.push(sentence.slice(0, KNOWLEDGE_LIMITS.MAX_CHUNK_CHARS));
      sentence = sentence.slice(KNOWLEDGE_LIMITS.MAX_CHUNK_CHARS);
    }
    if (current.length === 0) {
      current = sentence;
    } else if (current.length + 1 + sentence.length <= KNOWLEDGE_LIMITS.MAX_CHUNK_CHARS) {
      current += ` ${sentence}`;
    } else {
      out.push(current);
      current = sentence;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Agrupa parágrafos em pedaços de até MAX_CHUNK_CHARS.
 *
 * Duas invariantes, ambas verificadas por teste de propriedade:
 *  - nenhum pedaço excede MAX_CHUNK_CHARS;
 *  - nenhum conteúdo é descartado. Uma sobra final curta é fundida no pedaço anterior SOMENTE
 *    se couber; caso contrário vira pedaço próprio, ainda que abaixo de MIN_CHUNK_CHARS —
 *    preservar conteúdo vale mais que respeitar o tamanho mínimo.
 */
function splitByParagraph(body: string): string[] {
  const paragraphs: string[] = [];
  for (const p of body.split('\n\n')) {
    const trimmed = p.trim();
    if (trimmed.length > 0) paragraphs.push(...hardSplit(trimmed));
  }

  const out: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if (current.length === 0) {
      current = p;
    } else if (current.length + 2 + p.length <= KNOWLEDGE_LIMITS.MAX_CHUNK_CHARS) {
      current = `${current}\n\n${p}`;
    } else {
      out.push(current);
      current = p;
    }
  }
  if (current.length > 0) {
    const last = out[out.length - 1];
    const fits =
      last !== undefined && last.length + 2 + current.length <= KNOWLEDGE_LIMITS.MAX_CHUNK_CHARS;
    if (current.length < KNOWLEDGE_LIMITS.MIN_CHUNK_CHARS && fits) {
      out[out.length - 1] = `${last}\n\n${current}`;
    } else {
      out.push(current);
    }
  }
  return out;
}

/**
 * Segmenta markdown por cabeçalho de nível 2 e 3.
 *
 * A ordem de teste (### antes de ##) é indiferente para a correção: `^##\s+` não casa `### x`,
 * porque `#` não é whitespace. A mais específica vem primeiro por clareza.
 */
export function chunkMarkdown(agentId: string, markdown: string): KnowledgeChunk[] {
  const text = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const chunks: KnowledgeChunk[] = [];
  let currentH2 = '';
  let currentHeading: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (currentHeading === null) {
      buffer = [];
      return;
    }
    const body = buffer.join('\n').trim();
    buffer = [];
    if (body.length === 0) return;
    for (const piece of splitByParagraph(body)) {
      if (piece.length >= KNOWLEDGE_LIMITS.MIN_CHUNK_CHARS) {
        chunks.push({ agentId, headingPath: currentHeading, body: piece });
      }
    }
  };

  for (const line of text.split('\n')) {
    const h3 = /^###\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (h3) {
      flush();
      currentHeading = currentH2 ? `${currentH2} > ${h3[1]}` : h3[1];
      continue;
    }
    const h2 = /^##\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (h2) {
      flush();
      currentH2 = h2[1];
      currentHeading = currentH2;
      continue;
    }
    if (currentHeading !== null) buffer.push(line);
  }
  flush();
  return chunks;
}

/**
 * Carrega o corpus do disco. Ausência de arquivo NÃO é erro: devolve o que conseguiu ler, e um
 * corpus vazio faz o módulo `knowledge` ser reportado como indisponível — mesma regra de
 * honestidade que `voiceRuntime` aplica a `.runtime/`.
 */
export function loadKnowledgeCorpus(rootDir: string): KnowledgeChunk[] {
  const dir = path.join(rootDir, 'docs', 'research');
  const all: KnowledgeChunk[] = [];
  for (const { agentId, file } of SOURCES) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    all.push(...chunkMarkdown(agentId, text));
  }
  return all;
}
