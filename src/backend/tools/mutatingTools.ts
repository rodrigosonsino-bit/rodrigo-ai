import crypto from 'node:crypto';
import type { IMutatingTool } from '../../shared/extensions/tools.js';
import type { IntentName } from '../../shared/voiceProtocol.js';
import { JsonStore, type StoredItem } from '../storage/jsonStore.js';
import { ReminderScheduler } from './reminderScheduler.js';
import {
  parseRelativeTime,
  formatHumanRelative,
  parseRecurrence,
  formatRecurrenceHuman,
  type ParsedRelativeTime,
  type ParsedRecurrence
} from './relativeTimeParser.js';

export { type IMutatingTool };


export function findBestMatchingItemIndex(
  items: readonly StoredItem[],
  query: string
): { index: number; ambiguous: boolean; matches?: [StoredItem, StoredItem]; notFound?: boolean } {
  if (items.length === 0) return { index: -1, ambiguous: false };
  if (!query || !query.trim()) return { index: items.length - 1, ambiguous: false };

  const normQuery = query.toLowerCase().trim();
  const scored = items.map((item, idx) => {
    const normText = item.text.toLowerCase().trim();
    let score = 0;
    if (normText === normQuery) {
      score = 1.0;
    } else if (normText.length > 2 && normQuery.length > 2 && (normText.includes(normQuery) || normQuery.includes(normText))) {
      // Achado 3 (auditoria de código, Kimi K3, rodada da Fatia 4): a correção de palavras
      // curtas (wordsMatch, abaixo) não valia pro texto INTEIRO — um item com texto curto
      // ("1", "oi") era substring trivial de qualquer query mais longa que o contivesse,
      // ganhando 0.8 por acaso. Mesma doença do "o" coringa, um nível acima. Agora os dois
      // lados precisam ter mais de 2 caracteres pra essa correspondência frouxa valer; textos
      // curtos caem no scoring por palavra abaixo, que já exige igualdade exata pra eles.
      score = 0.8;
    } else {
      // Correção (Fatia 2 da F14, revisada na Fatia 4 após a suíte de estresse achar um
      // defeito real): a versão original filtrava palavras com length <= 2 e dividia só por
      // qWords.length — isso descartava dígitos/palavras curtas que eram exatamente o que
      // distinguia dois itens ("1" vs "2", "um" vs "dois") e deixava correspondência parcial
      // empatar com correspondência exata (Math.max(qWords.length, tWords.length) corrigiu
      // isso). Mas incluir palavras curtas SEM EXIGIR igualdade exata criou um bug pior: uma
      // palavra de 1 caractere como "o"/"a" (artigos comuníssimos em português) "contém" ou
      // "é contida" por quase qualquer palavra que tenha aquela letra — "comprar", "pão" e
      // "horas" todos incluem a letra "o", então o item errado "enviar O email..." empatava
      // com o item certo só por causa do "o" (achado real da suíte H14.2, cenário
      // D-reagendar-0: REAGENDAR com o texto completo do item + "daqui a N horas" virava
      // ambíguo contra um item totalmente não relacionado). A regra agora: correspondência por
      // substring só vale entre palavras com MAIS de 2 caracteres cada; palavras de 1-2
      // caracteres só contam se forem EXATAMENTE iguais — preserva a distinção por dígito/
      // palavra curta sem deixar peças curtas virarem coringas universais.
      const wordsMatch = (a: string, b: string): boolean => {
        if (a === b) return true;
        if (a.length <= 2 || b.length <= 2) return false;
        return a.includes(b) || b.includes(a);
      };
      const qWords = normQuery.split(/\s+/).filter((w) => w.length > 0);
      const tWords = normText.split(/\s+/).filter((w) => w.length > 0);
      let matchCount = 0;
      for (const qw of qWords) {
        if (tWords.some((tw) => wordsMatch(qw, tw))) matchCount += 1;
      }
      score = qWords.length > 0 ? matchCount / Math.max(qWords.length, tWords.length) : 0;
    }
    return { index: idx, item, score };
  });

  // Achado 7 (auditoria de código, Kimi K3): empate exato de score antes dependia da ordem de
  // iteração de `items` (JS sort é estável, mas a ordem de leitura do JsonStore não é um
  // contrato documentado). Desempate explícito por `createdAt` mais recente — determinístico e
  // nomeado, não um acidente de implementação.
  scored.sort((a, b) => b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt));
  const best = scored[0];
  const second = scored[1];

  // Achado 1 (auditoria de código, Kimi K3, CRÍTICO): quando a query NÃO é vazia mas nenhum
  // item se parece minimamente com ela (score < 0.2), a versão anterior caía pro item "mais
  // recente" em silêncio — exatamente o que a F14 existe pra eliminar. Cenário real: usuário
  // pede pra apagar/reagendar algo que já não existe (ou o ASR errou o nome) e o app mutaria o
  // item errado com uma confirmação que parece legítima, violando H14.2 ("zero alteração no
  // item errado"). Agora reporta notFound; os chamadores (preview/execute de cada ferramenta)
  // respondem "não encontrei" em vez de prosseguir.
  if (best.score < 0.2) {
    return { index: -1, ambiguous: false, notFound: true };
  }

  if (second && best.score - second.score < 0.15 && second.score >= 0.4) {
    return { index: -1, ambiguous: true, matches: [best.item, second.item] };
  }

  return { index: best.index, ambiguous: false };
}

export class LembreteTool implements IMutatingTool {
  readonly name = 'LEMBRETE';
  readonly description = 'Gerencia lembretes locais.';
  private lastParsed: { raw: string; parsed: ParsedRelativeTime } | null = null;
  private lastParsedRecurrence: { raw: string; parsed: ParsedRecurrence } | null = null;

  constructor(
    private readonly store: JsonStore<StoredItem>,
    private readonly scheduler: ReminderScheduler
  ) {}

  isAvailable(): boolean {
    return true;
  }

  preview(kind: IntentName, content: string | null): string {
    if (kind === 'LEMBRETE_CRIAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para criação de lembrete.');
      }

      const recurrenceParsed = parseRecurrence(content);
      if (recurrenceParsed.recurrence) {
        this.lastParsedRecurrence = { raw: content, parsed: recurrenceParsed };
        this.lastParsed = null;
        const finalText = recurrenceParsed.residualText.trim() || content;
        return `Posso criar o lembrete de ${finalText}, ${formatRecurrenceHuman(recurrenceParsed.recurrence)}?`;
      }
      this.lastParsedRecurrence = null;

      const parsed = parseRelativeTime(content);
      this.lastParsed = { raw: content, parsed };

      const finalText = parsed.residualText.trim() || content;
      if (parsed.dueAt) {
        return `Posso criar o lembrete de ${finalText} para ${formatHumanRelative(parsed.dueAt)}?`;
      }
      return `Posso criar o lembrete: ${finalText}?`;
    }
    
    if (kind === 'LEMBRETE_CONSULTAR') {
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Você não tem nenhum lembrete salvo.';
      }
      const filter = (content || '').toLowerCase().trim();
      const matches = filter
        ? store.items.filter((item) => item.text.toLowerCase().includes(filter))
        : store.items;
      if (matches.length === 0) {
        return 'Não encontrei nenhum lembrete sobre isso.';
      }
      const top = matches.slice(-3);
      const itemsStr = top.map((i) => i.text).join('; ');
      return `Você tem ${matches.length} ${matches.length === 1 ? 'lembrete' : 'lembretes'}: ${itemsStr}.`;
    }

    if (kind === 'LEMBRETE_REAGENDAR') {
      // Achado (auditoria desta rodada): preview() NUNCA muta — só pergunta. O reagendamento de
      // verdade (store.write + scheduler.schedule) só pode acontecer em execute(), depois do "sim".
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para reagendar lembrete.');
      }
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhum lembrete para reagendar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content);
      if (matchResult.notFound) {
        return `Não encontrei nenhum lembrete parecido com "${content}" pra reagendar.`;
      }
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei dois lembretes parecidos: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer alterar?`;
      }
      const current = store.items[matchResult.index];
      const timeParsed = parseRelativeTime(content);
      if (!timeParsed.dueAt) {
        return 'Não entendi o novo horário do lembrete.';
      }
      return `Posso reagendar o lembrete "${current.text}" para ${formatHumanRelative(timeParsed.dueAt)}?`;
    }

    if (kind === 'LEMBRETE_EDITAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para editar lembrete.');
      }
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhum lembrete para editar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content);
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei dois lembretes parecidos: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer alterar?`;
      }
      // EDITAR: content é o NOVO valor, não uma descrição do item antigo — ao contrário de
      // APAGAR/REAGENDAR, raramente se parece com o texto que está sendo substituído ("comprar
      // pão" -> "buscar as crianças" não tem palavra em comum, e isso é normal). "Não encontrei"
      // aqui seria falso negativo frequente; sem match forte, cai pro item mais recente
      // (comportamento herdado, inofensivo porque a pergunta de confirmação mostra qual item
      // foi escolhido antes de qualquer mutação).
      const idx = matchResult.notFound ? store.items.length - 1 : matchResult.index;
      const current = store.items[idx];
      return `Posso trocar o lembrete "${current.text}" para: ${content.trim()}?`;
    }
    if (kind === 'LEMBRETE_APAGAR') {
      // Conteúdo aqui é uma PISTA de desambiguação, não um requisito — diferente de EDITAR
      // (onde content é o novo valor, obrigatório). "Apaga esse lembrete" sem citar qual é o
      // caso comum por voz, e findBestMatchingItemIndex já sabe cair pro mais recente quando
      // query é vazia/nula; exigir conteúdo aqui quebraria exatamente esse caso comum.
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhum lembrete para apagar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content ?? '');
      if (matchResult.notFound) {
        return `Não encontrei nenhum lembrete parecido com "${content}" pra apagar.`;
      }
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei dois lembretes parecidos: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer apagar?`;
      }
      const current = store.items[matchResult.index];
      return `Posso apagar o lembrete "${current.text}"?`;
    }
    throw new Error(`Ação inválida para LembreteTool: ${kind}`);
  }

  execute(kind: IntentName, content: string | null): string {
    // Achado 8 (auditoria de código, Hermes, 2026-09-24): captura o cache e limpa
    // incondicionalmente aqui, independente do kind — um preview(LEMBRETE_CRIAR) seguido de um
    // execute(LEMBRETE_APAGAR) (usuário muda de ideia entre a pergunta e a confirmação) não pode
    // deixar `lastParsed` sobrevivendo para contaminar uma criação de lembrete não relacionada
    // mais tarde. `cachedParsed` guarda o valor capturado antes da limpeza, pro ramo CRIAR usar.
    const cachedParsed = this.lastParsed;
    const cachedRecurrence = this.lastParsedRecurrence;
    this.lastParsed = null;
    this.lastParsedRecurrence = null;

    if (kind === 'LEMBRETE_CONSULTAR') {
      return this.preview(kind, content);
    }

    if (kind === 'LEMBRETE_REAGENDAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para reagendar lembrete.');
      }
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhum lembrete para reagendar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content);
      if (matchResult.notFound) {
        return `Não encontrei nenhum lembrete parecido com "${content}" pra reagendar.`;
      }
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei dois lembretes parecidos: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer alterar?`;
      }
      const idx = matchResult.index;
      const current = store.items[idx];
      const timeParsed = parseRelativeTime(content);
      if (!timeParsed.dueAt) {
        return 'Não entendi o novo horário do lembrete.';
      }
      store.items[idx] = { ...current, dueAt: timeParsed.dueAt, notifiedAt: null };
      this.store.write(store);
      try {
        this.scheduler.schedule({ id: current.id, text: current.text, dueAt: timeParsed.dueAt });
      } catch (err) {
        console.error('[mutation] lembrete reagendado no store, mas o agendamento falhou:', err);
        return 'Reagendei no registro, mas não consegui atualizar o aviso.';
      }
      return 'Lembrete reagendado com sucesso.';
    }

    if (kind === 'LEMBRETE_EDITAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para editar lembrete.');
      }
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhum lembrete para editar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content);
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei dois lembretes parecidos: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer alterar?`;
      }
      // Achado D5 (auditoria da própria suíte de estresse, Fatia 4): propagar `notFound`
      // pra cá regrediu o H7 da Fase 9 e o H14.1 do phase14Stress — execute(EDITAR) passou
      // a responder "não encontrei" quando o content é o TEXTO NOVO ("todo domingo de manhã
      // passear", "buscar as crianças"), que por definição não se parece com nenhum item
      // existente. preview(LEMBRETE_EDITAR) já reconhecia isso e caía pro item mais recente
      // (ver comentário lá); o execute ficou inconsistente com a pergunta já confirmada.
      // Seguro porque a confirmação do preview mostra qual item será trocado antes da
      // mutação, e porque as recusas semânticas (recorrência, horário) abaixo dependem de
      // chegar até aqui.
      const idx = matchResult.notFound ? store.items.length - 1 : matchResult.index;
      const current = store.items[idx];

      if (current.notifiedAt) {
        return 'Esse lembrete já foi disparado, não é possível editar mais.';
      }

      const trimmed = content.trim();

      const wouldBeRecurrent = parseRecurrence(trimmed).recurrence !== null;
      if (wouldBeRecurrent) {
        return 'Não dá pra mudar a recorrência editando o texto — apague e crie um lembrete novo.';
      }

      const wouldScheduleTime = parseRelativeTime(trimmed).dueAt !== null;
      if (wouldScheduleTime) {
        return 'Não dá pra mudar o horário editando o texto — apague e crie um lembrete novo com o horário certo.';
      }

      if (current.text === trimmed) {
        return 'Isso já era o texto do lembrete.';
      }

      store.items[idx] = { ...current, text: trimmed };
      this.store.write(store);
      return 'Lembrete atualizado.';
    }

    if (kind === 'LEMBRETE_CRIAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para criação de lembrete.');
      }

      const recurrenceParsed =
        cachedRecurrence && cachedRecurrence.raw === content
          ? cachedRecurrence.parsed
          : parseRecurrence(content);

      if (recurrenceParsed.recurrence) {
        const { recurrence, dueAt, residualText } = recurrenceParsed;
        const finalText = residualText.trim() || content;
        const store = this.store.read();
        const last = store.items[store.items.length - 1];

        // Dedupe considera recurrence agora (achado 6) — sem isso, um lembrete único com o mesmo
        // texto/horário da primeira ocorrência de um recorrente seria barrado por engano:
        const isDuplicate =
          last &&
          last.text === finalText &&
          (last.dueAt ?? null) === (dueAt ?? null) &&
          JSON.stringify(last.recurrence ?? null) === JSON.stringify(recurrence) &&
          last.notifiedAt === null;

        if (isDuplicate) {
          return 'Isso já estava salvo.';
        }

        const id = crypto.randomUUID();
        store.items.push({
          id,
          text: finalText,
          createdAt: new Date().toISOString(),
          dueAt,
          notifiedAt: null,
          recurrence
        });
        this.store.write(store);
        try {
          this.scheduler.schedule({ id, text: finalText, dueAt: dueAt! });
        } catch (err) {
          // F11 H11.4: o item JÁ foi gravado; dizer "não consegui salvar" seria falso. Diz a verdade.
          console.error('[mutation] lembrete gravado, mas o agendamento falhou:', err);
          return 'Guardei o lembrete, mas não consegui agendar o aviso.';
        }
        return `Lembrete criado, vou te avisar ${formatRecurrenceHuman(recurrence)}.`;
      }

      // Reusa o parsing validado na pergunta ou roda fallback se chamado diretamente
      const parsed =
        cachedParsed && cachedParsed.raw === content
          ? cachedParsed.parsed
          : parseRelativeTime(content);

      const { dueAt, residualText } = parsed;
      const finalText = residualText.trim() || content;

      const store = this.store.read();
      const last = store.items[store.items.length - 1];

      // Correção do Achado 5: deduplicação temporal segura
      const isDuplicate =
        last &&
        last.text === finalText &&
        (last.dueAt ?? null) === (dueAt ?? null) &&
        JSON.stringify(last.recurrence ?? null) === JSON.stringify(null) &&
        last.notifiedAt === null;

      if (isDuplicate) {
        return 'Isso já estava salvo.';
      }

      const id = crypto.randomUUID();
      store.items.push({
        id,
        text: finalText,
        createdAt: new Date().toISOString(),
        dueAt,
        notifiedAt: null
      });
      this.store.write(store);

      if (dueAt) {
        // Achado 4 (auditoria de código, Kimi K3): o ramo recorrente, logo acima, já protegia
        // schedule() com try/catch; este ramo (bem mais frequentado) chamava a céu aberto —
        // qualquer exceção síncrona derrubaria o processo em vez de reportar honestamente.
        try {
          this.scheduler.schedule({ id, text: finalText, dueAt });
        } catch (err) {
          console.error('[mutation] lembrete gravado, mas o agendamento falhou:', err);
          return 'Guardei o lembrete, mas não consegui agendar o aviso.';
        }
        return `Lembrete criado para ${formatHumanRelative(dueAt)}.`;
      }
      return 'Lembrete criado.';
    }

    if (kind === 'LEMBRETE_APAGAR') {
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhum lembrete para apagar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content ?? '');
      if (matchResult.notFound) {
        return `Não encontrei nenhum lembrete parecido com "${content}" pra apagar.`;
      }
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei dois lembretes parecidos: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer apagar?`;
      }
      const idx = matchResult.index;
      const removed = store.items.splice(idx, 1)[0];
      // Cancela o agendamento em memória se houver
      this.scheduler.cancel(removed.id);
      this.store.write(store);
      return 'Lembrete apagado.';
    }

    throw new Error(`Ação inválida para LembreteTool: ${kind}`);
  }
}

export class NotaTool implements IMutatingTool {
  readonly name = 'NOTA';
  readonly description = 'Gerencia notas locais.';

  constructor(private readonly store: JsonStore<StoredItem>) {}

  isAvailable(): boolean {
    return true;
  }

  preview(kind: IntentName, content: string | null): string {
    if (kind === 'NOTA_CRIAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para criação de nota.');
      }
      return `Posso guardar a nota: ${content}?`;
    }
    
    if (kind === 'NOTA_CONSULTAR') {
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Você não tem nenhuma nota salva.';
      }
      const filter = (content || '').toLowerCase().trim();
      const matches = filter
        ? store.items.filter((item) => item.text.toLowerCase().includes(filter))
        : store.items;
      if (matches.length === 0) {
        return 'Não encontrei nenhuma nota sobre isso.';
      }
      const top = matches.slice(-3);
      const itemsStr = top.map((i) => i.text).join('; ');
      return `Encontrei ${matches.length} ${matches.length === 1 ? 'nota' : 'notas'}: ${itemsStr}.`;
    }

    if (kind === 'NOTA_EDITAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para editar nota.');
      }
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhuma nota para editar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content);
      if (matchResult.notFound) {
        return `Não encontrei nenhuma nota parecida com "${content}" pra editar.`;
      }
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei duas notas parecidas: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer alterar?`;
      }
      const current = store.items[matchResult.index];
      return `Posso trocar a nota "${current.text}" para: ${content.trim()}?`;
    }
    if (kind === 'NOTA_APAGAR') {
      // Conteúdo aqui é pista de desambiguação, não requisito — ver comentário equivalente em
      // LEMBRETE_APAGAR.
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhuma nota para apagar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content ?? '');
      if (matchResult.notFound) {
        return `Não encontrei nenhuma nota parecida com "${content}" pra apagar.`;
      }
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei duas notas parecidas: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer apagar?`;
      }
      const current = store.items[matchResult.index];
      return `Posso apagar a nota "${current.text}"?`;
    }
    throw new Error(`Ação inválida para NotaTool: ${kind}`);
  }

  execute(kind: IntentName, content: string | null): string {
    if (kind === 'NOTA_CONSULTAR') {
      return this.preview(kind, content);
    }
    if (kind === 'NOTA_EDITAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para editar nota.');
      }
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhuma nota para editar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content);
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei duas notas parecidas: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer alterar?`;
      }
      // Mesmo achado D5 de LembreteTool.execute(LEMBRETE_EDITAR): content aqui é o novo
      // valor, que não precisa se parecer com o texto antigo — sem match forte, cai pro
      // item mais recente (o preview da confirmação já mostra qual).
      const idx = matchResult.notFound ? store.items.length - 1 : matchResult.index;
      const current = store.items[idx];
      const trimmed = content.trim();

      if (current.text === trimmed) {
        return 'Isso já era o texto da nota.';
      }

      store.items[idx] = { ...current, text: trimmed };
      this.store.write(store);
      return 'Nota atualizada.';
    }

    if (kind === 'NOTA_CRIAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para criação de nota.');
      }
      const store = this.store.read();
      const last = store.items[store.items.length - 1];
      if (last && last.text === content) {
        return 'Isso já estava salvo.';
      }
      store.items.push({
        id: crypto.randomUUID(),
        text: content,
        createdAt: new Date().toISOString()
      });
      this.store.write(store);
      return 'Nota criada.';
    }

    if (kind === 'NOTA_APAGAR') {
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhuma nota para apagar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content ?? '');
      if (matchResult.notFound) {
        return `Não encontrei nenhuma nota parecida com "${content}" pra apagar.`;
      }
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei duas notas parecidas: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer apagar?`;
      }
      const idx = matchResult.index;
      store.items.splice(idx, 1);
      this.store.write(store);
      return 'Nota apagada.';
    }

    throw new Error(`Ação inválida para NotaTool: ${kind}`);
  }
}

export class MemoriaTool implements IMutatingTool {
  readonly name = 'MEMORIA';
  readonly description = 'Guarda e esquece fatos/preferências do usuário entre sessões.';

  constructor(private readonly store: JsonStore<StoredItem>) {}

  isAvailable(): boolean {
    return true;
  }

  preview(kind: IntentName, content: string | null): string {
    if (kind === 'MEMORIA_GUARDAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para guardar memória.');
      }
      return `Posso guardar isso sobre você: ${content}?`;
    }
    
    if (kind === 'MEMORIA_CONSULTAR') {
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Você não tem nenhuma memória salva.';
      }
      const filter = (content || '').toLowerCase().trim();
      const matches = filter
        ? store.items.filter((item) => item.text.toLowerCase().includes(filter))
        : store.items;
      if (matches.length === 0) {
        return 'Não encontrei nenhuma memória guardada sobre isso.';
      }
      const top = matches.slice(-3);
      const itemsStr = top.map((i) => i.text).join('; ');
      return `Lembro de ${matches.length} ${matches.length === 1 ? 'coisa' : 'coisas'}: ${itemsStr}.`;
    }

    if (kind === 'MEMORIA_EDITAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para editar memória.');
      }
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nada guardado para editar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content);
      if (matchResult.notFound) {
        return `Não encontrei nenhuma memória parecida com "${content}" pra editar.`;
      }
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei duas memórias parecidas: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer alterar?`;
      }
      const current = store.items[matchResult.index];
      return `Posso trocar a memória "${current.text}" para: ${content.trim()}?`;
    }
    if (kind === 'MEMORIA_ESQUECER') {
      // Achado 2 (CRÍTICA, rodada 1): "apagar", nunca "esquecer" — a palavra "esquece" está em
      // NEGATION_MARKERS (sessionManager.ts) e vetaria a própria confirmação afirmativa.
      // Achado novo (BAIXA, rodada 2): frase curta, simétrica a LEMBRETE_APAGAR/NOTA_APAGAR —
      // uma cauda como "...que você me pediu para guardar?" reintroduziria "guardar", que é ele
      // mesmo um marcador afirmativo ('pode guardar'), abrindo espaço pra ambiguidade contrária.
      // Conteúdo aqui é pista de desambiguação, não requisito — ver comentário equivalente em
      // LEMBRETE_APAGAR.
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nada guardado pra apagar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content ?? '');
      if (matchResult.notFound) {
        return `Não encontrei nenhuma memória parecida com "${content}" pra apagar.`;
      }
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei duas memórias parecidas: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer apagar?`;
      }
      const current = store.items[matchResult.index];
      return `Posso apagar a memória "${current.text}"?`;
    }
    throw new Error(`Ação inválida para MemoriaTool: ${kind}`);
  }

  execute(kind: IntentName, content: string | null): string {
    if (kind === 'MEMORIA_CONSULTAR') {
      return this.preview(kind, content);
    }
    if (kind === 'MEMORIA_EDITAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para editar memória.');
      }
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nada guardado para editar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content);
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei duas memórias parecidas: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer alterar?`;
      }
      // Mesmo achado D5 de LembreteTool.execute(LEMBRETE_EDITAR): content aqui é o novo
      // valor — sem match forte, cai pro item mais recente (o preview da confirmação já
      // mostra qual item será trocado).
      const idx = matchResult.notFound ? store.items.length - 1 : matchResult.index;
      const trimmed = content.trim();
      const normalized = trimmed.toLowerCase();

      if (store.items[idx].text.trim().toLowerCase() === normalized) {
        return 'Isso já era o texto guardado.';
      }

      const isDuplicateOfOther = store.items.some(
        (it, i) => i !== idx && it.text.trim().toLowerCase() === normalized
      );
      if (isDuplicateOfOther) {
        return 'Isso já estava guardado.';
      }

      store.items[idx] = { ...store.items[idx], text: trimmed };
      this.store.write(store);
      return 'Atualizado.';
    }

    if (kind === 'MEMORIA_GUARDAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para guardar memória.');
      }
      const store = this.store.read();
      // Achado 7 (MÉDIA, rodada 1): checa o array inteiro, não só o último item — memória é
      // lista estática de fatos, não um log temporal como NotaTool.
      const normalized = content.trim().toLowerCase();
      const isDuplicate = store.items.some((it) => it.text.trim().toLowerCase() === normalized);
      if (isDuplicate) {
        return 'Isso já estava guardado.';
      }
      store.items.push({
        id: crypto.randomUUID(),
        text: content,
        createdAt: new Date().toISOString()
      });
      this.store.write(store);
      return 'Guardado.';
    }

    if (kind === 'MEMORIA_ESQUECER') {
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nada guardado pra apagar.';
      }
      const matchResult = findBestMatchingItemIndex(store.items, content ?? '');
      if (matchResult.notFound) {
        return `Não encontrei nenhuma memória parecida com "${content}" pra apagar.`;
      }
      if (matchResult.ambiguous && matchResult.matches) {
        return `Encontrei duas memórias parecidas: "${matchResult.matches[0].text}" e "${matchResult.matches[1].text}". Qual você quer apagar?`;
      }
      const idx = matchResult.index;
      store.items.splice(idx, 1);
      this.store.write(store);
      return 'Apagado.';
    }

    throw new Error(`Ação inválida para MemoriaTool: ${kind}`);
  }
}

/** Filtro permissivo especificado em docs/phase-5c-v3.md §4.2 e atualizado na Fase 7 §4.1, Fase 8 §4.4 e Controle Desktop v5. */
const MUTATION_GATE =
  /\b(lembr|anot|guard|escrev|salv|apag|esquec|cancel|nota|lembrete|aviso|tarefa|compromisso|registr|memor|grava|grave|gravou|gravand|gravar|avis|delet|alter|some|toque|acord|bota|zera|reescrev|desfaz|limp|errad|confund|volum|som|mudo|muta|desmuta|paus|toca|musica|faixa|proxim|anterior|abr|fech|encerr|modo|escur|clar|minimiz|janel|pasta|download|document|desktop|lixeir|bloque|repous|dorm|suspens|reinici|reboot|deslig|digit|colar|cola|ditad|traduz|selec|substitu|anex|complet|preench|mensag|envi|campo|voz|luciana|felipe|charon|puck|kokoro|aoede|fenrir|kore|zephyr|autocorrig|melhoria|refator|codigo)\w*\b|\b(edita|editar|edite|editou|editando|troca|trocar|troque|trocou|trocando|corrige|corrigir|corrija|corrigiu|corrigindo|auto\s*corrig\w*|auto\s*correc\w*)\b/;

export function mightBeMutation(transcript: string): boolean {
  const n = transcript
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
  return MUTATION_GATE.test(n);
}

/**
 * Deriva o prefixo da ação (LEMBRETE_/NOTA_) e encontra a MESMA instância que trata as duas
 * ações desse prefixo — especificado em docs/phase-5c-v2.md §6.4.
 */
export type SyncMutatingTool = Omit<IMutatingTool, 'execute'> & {
  execute(kind: IntentName, content: string | null): string;
};

export function selectMutatingToolByAction<T extends IMutatingTool = IMutatingTool>(
  kind: string,
  tools: readonly T[]
): T | null {
  const prefix = kind.split('_')[0].toUpperCase();
  return tools.find((t) => t.name.toUpperCase() === prefix && t.isAvailable()) ?? null;
}
export interface MutatingToolsResult {
  tools: SyncMutatingTool[];
  scheduler: ReminderScheduler;
  memoriaStore: JsonStore<StoredItem>;
}

/**
 * `customScheduler`, se passado, DEVE ter sido construído com o mesmo `JsonStore` de lembretes
 * que este `baseDir` produziria (`new JsonStore(baseDir, 'lembretes.json')`) — achado 5 (auditoria
 * de código, Hermes, 2026-09-24): um scheduler apontando para um store diferente agenda o timer
 * normalmente, mas `fire()` nunca encontra o item nesse store e a notificação nunca dispara, sem
 * nenhum erro visível. Em produção `customScheduler` nunca é passado (voiceRuntime.ts usa o
 * default); o parâmetro existe só para testes injetarem um scheduler mockável.
 */
export function createMutatingTools(
  baseDir: string,
  customScheduler?: ReminderScheduler
): MutatingToolsResult {
  const lembreteStore = new JsonStore<StoredItem>(baseDir, 'lembretes.json');
  const notaStore = new JsonStore<StoredItem>(baseDir, 'notas.json');
  const memoriaStore = new JsonStore<StoredItem>(baseDir, 'memorias.json');

  const scheduler = customScheduler ?? new ReminderScheduler(lembreteStore);
  const lembreteTool = new LembreteTool(lembreteStore, scheduler);
  const notaTool = new NotaTool(notaStore);
  const memoriaTool = new MemoriaTool(memoriaStore);

  return {
    tools: [lembreteTool, notaTool, memoriaTool],
    scheduler,
    memoriaStore
  };
}
