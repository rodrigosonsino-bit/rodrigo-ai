/**
 * Fase 11 — classificador DETERMINÍSTICO de confirmação (substitui Camadas 0/1/2 da 5c).
 *
 * Decisão de projeto (docs/phase-11-v1.md §3): quem autoriza uma mutação não pode ser um LLM
 * de 4B parâmetros seguido de um gate de lista de palavras. Aqui a regra é de MUNDO FECHADO:
 *
 *   NAO      — qualquer marcador de negação/cancelamento, em qualquer posição. Vence tudo.
 *   SIM      — a fala INTEIRA é composta só de vocabulário afirmativo/preenchimento conhecido,
 *              com pelo menos um token afirmativo forte, sem '?', curta.
 *   AMBIGUO  — todo o resto (token desconhecido, hesitação, pergunta, mudança de assunto).
 *              O chamador pergunta UMA vez de novo; nunca executa.
 *
 * Por construção, "SIM" exige que cada palavra da fala esteja na lista fechada: uma negação,
 * hesitação ou assunto novo contém ao menos um token fora dela. O que a lista não cobre custa
 * uma pergunta repetida (cobertura), nunca uma execução indevida (segurança).
 *
 * Limite estrutural, não corrigível em texto: se o STT engolir a palavra de negação e o resíduo
 * for, por si, uma afirmação ("não, pode fazer" -> "pode fazer"), a informação nunca chega aqui.
 */

export type ConfirmationVerdict = 'SIM' | 'NAO' | 'AMBIGUO';

/** Ação pendente que está sendo confirmada (sufixo do MutationName); habilita a checagem verbo×ação. */
export type PendingActionGroup = 'CREATE' | 'DELETE' | 'EDIT';

export function actionGroupOf(kind: string): PendingActionGroup | null {
  const k = kind.toUpperCase();
  if (
    k.endsWith('_CRIAR') ||
    k === 'MEMORIA_GUARDAR' ||
    k === 'DIGITAR_TEXTO' ||
    k === 'DIGITAR_INSERIR' ||
    k === 'DIGITAR_ANEXAR' ||
    k === 'DIGITAR_LIMPAR_INSERIR' ||
    k === 'DIGITAR_TRADUZIR_INSERIR'
  ) {
    return 'CREATE';
  }
  if (k.endsWith('_APAGAR') || k === 'MEMORIA_ESQUECER' || k === 'DESKTOP_CRITICO') return 'DELETE';
  if (k.endsWith('_EDITAR') || k === 'AUTO_CORRECAO' || k === 'DIGITAR_SUBSTITUIR_SELECAO') return 'EDIT';
  return null;
}

const VERB_GROUP: Record<string, PendingActionGroup> = {};
for (const v of ['cria', 'crie', 'criar', 'salva', 'salve', 'salvar', 'guarda', 'guarde', 'guardar',
  'anota', 'anote', 'anotar', 'marca', 'marque', 'marcar', 'grava', 'grave', 'gravar',
  'registra', 'registre', 'registrar', 'digita', 'digite', 'digitar', 'cola', 'cole', 'colar']) VERB_GROUP[v] = 'CREATE';
for (const v of ['apaga', 'apague', 'apagar', 'esvazia', 'esvazie', 'esvaziar']) VERB_GROUP[v] = 'DELETE';
for (const v of ['troca', 'troque', 'trocar', 'edita', 'edite', 'editar', 'corrige', 'corrija',
  'corrigir', 'muda', 'mude', 'mudar', 'atualiza', 'atualize', 'atualizar']) VERB_GROUP[v] = 'EDIT';

export interface ConfirmationResult {
  verdict: ConfirmationVerdict;
  reason: string;
}

const MAX_SIM_TOKENS = 8;

export function normalizeForConfirmation(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Frases de negação (casadas na fala normalizada, com fronteira de palavra). */
const NEGATION_PHRASES = [
  'deixa quieto', 'deixa pra la', 'deixa pra depois', 'deixa isso', 'deixa pra',
  'deixa para', 'deixa para la', 'deixa para depois', 'deixe quieto', 'deixa de lado',
  'mudei de ideia', 'de jeito nenhum', 'sai fora', 'para tudo', 'larga isso', 'larga mao'
];

/** Tokens de negação/cancelamento: presença em QUALQUER posição => NAO. */
const NEGATION_TOKENS = new Set([
  'nao', 'nem', 'nunca', 'jamais', 'nada', 'ninguem', 'nenhum', 'nenhuma', 'negativo',
  'cancela', 'cancele', 'cancelar', 'cancelei', 'cancelado', 'cancelo',
  'esquece', 'esqueca', 'esquecer', 'esqueci',
  'desisti', 'desisto', 'desistir', 'desiste',
  'errado', 'errada', 'errei', 'errou', 'incorreto', 'incorreta', 'erro',
  'pare', 'parar', 'chega', 'basta',
  'tira', 'tire', 'tirar', 'remove', 'remova', 'sem',
  'anula', 'anular', 'desfaz', 'desfazer', 'nega', 'negar', 'desmarca', 'desmarcar', 'ignora',
  'ignorar', 'desconsidera', 'desconsiderar', 'corta', 'cortar', 'aborta', 'abortar', 'interrompe',
  'interromper', 'suspende', 'suspender', 'dispensa', 'dispensar', 'reverte', 'reverter', 'riscar',
  'risca', 'congela', 'fora', 'atras', 'volta', 'voltar'
]);

/** "sem" dentro de uma fala maior é preposição: só vale como negação sozinho. "para" no INÍCIO é ordem de parar. */
const NEGATION_ONLY_WHEN_ALONE = new Set(['sem']);

/** Frases afirmativas fortes — contam como token forte e são removidas antes da checagem de vocabulário. */
const STRONG_PHRASES = [
  'fechou negocio', 'e pra ja', 'mao na massa',
  'pode crer que sim', 'pode crer', 'claro que pode', 'bora que sim',
  'manda ver', 'mande ver', 'mandar ver', 'pode sim', 'com certeza', 'sem duvida', 'claro que sim', 'isso mesmo',
];

/** Tokens afirmativos fortes. */
const STRONG_TOKENS = new Set([
  'sim', 'claro', 'confirmo', 'confirma', 'confirmar', 'confirmado', 'positivo', 'pode', 'fechou',
  'fechado', 'manda', 'mande', 'bora', 'perfeito', 'combinado', 'aceito', 'autorizo', 'autorizado',
  'faz', 'faca', 'fazer', 'vai', 'vamos', 'vamo', 'segue', 'seguir', 'proceder', 'prossiga', 'prossegue',
  'prosseguir', 'avancar', 'avanca', 'firmou', 'acertou', 'executa', 'executar', 'roda', 'rodar', 'aprova', 'aprovado', 'fecha', 'fechar',
  'topo', 'topa', 'topar', 'acertado',
  ...Object.keys(VERB_GROUP)
]);

/**
 * Reconhecimentos fracos: soam como "sim", mas também aparecem em fala solta, sarcasmo ("ah, tá
 * bom") ou encerramento ("beleza, valeu"). Só valem quando a fala INTEIRA é curta e sem interjeição.
 */
const SOFT_TOKENS = new Set([
  'certo', 'ok', 'okay', 'blz', 'beleza', 'otimo', 'show', 'tranquilo', 'correto',
  'valendo', 'sussa', 'liberado', 'liberada', 'isso', 'exato', 'exatamente',
  'suave', 'firme', 'certinho'
]);
const SOFT_PHRASES = ['ta bom', 'esta bom', 'ta certo', 'esta certo', 'ta valendo', 'esta valendo',
  'ta fechado', 'esta fechado', 'ta combinado', 'esta combinado'];
const SOFT_MAX_TOKENS = 2;
/** 'hum'/'hm' (hesitação) ficam FORA de propósito: nunca são vocabulário aceito. */
const INTERJECTIONS = new Set(['ah', 'uai', 'oxi', 'vish', 'cara', 'ue']);
/** Interjeições de surpresa/hesitação/ironia: com elas, nenhum caminho produz SIM. */
const HEDGING_INTERJECTIONS = new Set(['vish', 'uai', 'oxi', 'ue']);
const THANKS = new Set(['valeu', 'vlw', 'obrigado', 'obrigada']);


/** Preenchimento neutro: pode acompanhar a afirmação, mas não a sustenta sozinho. */
const FILLER_TOKENS = new Set([
  'aham', 'uhum', 'ahan', 'demorou',
  'ai', 'a', 'o', 'e', 'eh', 'ne', 'entao', 'ta', 'esta', 'bom', 'bem', 'tudo', 'esse', 'essa',
  'isto', 'pra', 'mim', 'me', 'por', 'favor', 'mesmo', 'demais', 'certinho', 'uma', 'um',
  'lembrete', 'nota', 'memoria', 'bala', 'obrigado', 'obrigada', 'valeu', 'vlw', 'amem',
  'em', 'de', 'boa', 'frente', 'fundo', 'la', 'nessa', 'nisso', 'desse', 'jeito', 'linha', 'total',
  'assim', 'brasa', 'ah', 'cara', 'uai', 'oxi', 'vish', 'falou', 'nois', 'ir', 'top', 'massa',
  'maravilha', 'joia', 'legal', 'absoluta', 'comigo', 'pa', 'nos', 'negocio', 'senhor', 'continua', 'continuar', 'mandar', 'logo', 'com', 'to', 'acordo'
]);

/** Pontuação tolerada; qualquer outro símbolo (emoji, '？', etc.) impede o SIM. */
const ALLOWED_PUNCT_RE = /[\p{L}\p{M}\p{N}\s.,!;:'"\-…]/gu;
const QUESTION_RE = /[?？¿‽؟]/;

/** Frases sem força própria: removidas antes da checagem de vocabulário; não contam como afirmação. */
const WEAK_PHRASES = ['sem problema', 'de acordo', 'semstress', 'semerro', 'to dentro', 'to contigo', 'to junto',
  'to pronto', 'to ligado', 'to na mao', 'conta comigo', 'manda o pau', 'manda o jogo', 'vamos embora',
  'por conta'];
const WEAK_PHRASE_REGEXES = WEAK_PHRASES.map((p) => new RegExp(`\\b${p}\\b`, 'g'));

const STRONG_PHRASE_REGEXES = STRONG_PHRASES.map((p) => new RegExp(`\\b${p}\\b`, 'g'));
const NEGATION_PHRASE_REGEXES = NEGATION_PHRASES.map((p) => new RegExp(`\\b${p}\\b`));

export function classifyConfirmation(transcript: string, pendingKind?: string): ConfirmationResult {
  const raw = transcript ?? '';
  const n = normalizeForConfirmation(raw);
  if (!n) return { verdict: 'AMBIGUO', reason: 'fala vazia' };

  // "sem dúvida" não é negação: mascara antes de procurar 'sem'.
  const masked = n
    .replace(/\bsem duvida\b/g, 'comcerteza')
    .replace(/\bsem erro\b/g, 'semerro')
    .replace(/\bsem stress\b/g, 'semstress');
  const tokens = masked.split(' ');

  for (const re of NEGATION_PHRASE_REGEXES) {
    if (re.test(masked)) return { verdict: 'NAO', reason: `frase de negação` };
  }
  if (tokens[0] === 'para') return { verdict: 'NAO', reason: 'ordem de parar' };
  for (const t of tokens) {
    if (NEGATION_TOKENS.has(t)) {
      if (NEGATION_ONLY_WHEN_ALONE.has(t) && tokens.length > 1) continue;
      return { verdict: 'NAO', reason: `token de negação: ${t}` };
    }
  }

  if (QUESTION_RE.test(raw)) return { verdict: 'AMBIGUO', reason: 'pergunta' };
  if (raw.replace(ALLOWED_PUNCT_RE, '').trim()) return { verdict: 'AMBIGUO', reason: 'símbolo desconhecido' };
  if (tokens.length > MAX_SIM_TOKENS) return { verdict: 'AMBIGUO', reason: 'fala longa demais' };

  let rest = ` ${masked} `;
  let strong = false;
  let soft = false;
  for (const re of WEAK_PHRASE_REGEXES) rest = rest.replace(re, ' ');
  for (const re of STRONG_PHRASE_REGEXES) {
    if (re.test(rest)) {
      strong = true;
      rest = rest.replace(re, ' ');
    }
    re.lastIndex = 0;
  }
  for (const ph of SOFT_PHRASES) {
    const re = new RegExp(`\\b${ph}\\b`, 'g');
    if (re.test(rest)) { soft = true; rest = rest.replace(re, ' '); }
  }
  const expected = pendingKind ? actionGroupOf(pendingKind) : null;
  const unknowns: string[] = [];
  for (const t of rest.split(' ').filter(Boolean)) {
    if (t === 'comcerteza') { strong = true; continue; }
    const group = VERB_GROUP[t];
    if (group && expected && group !== expected) {
      return { verdict: 'AMBIGUO', reason: `verbo ${t} não corresponde à ação pendente` };
    }
    if (STRONG_TOKENS.has(t)) { strong = true; continue; }
    if (SOFT_TOKENS.has(t)) { soft = true; continue; }
    if (FILLER_TOKENS.has(t) || INTERJECTIONS.has(t)) continue;
    unknowns.push(t);
  }
  // Mundo fechado: qualquer palavra fora do vocabulário => AMBIGUO (auditoria Kimi 2026-10-03:
  // uma regra relaxada com âncora inicial deixava "claro que podia" virar SIM).
  if (unknowns.length > 0) return { verdict: 'AMBIGUO', reason: `token fora do vocabulário: ${unknowns[0]}` };
  if (tokens.some((t) => HEDGING_INTERJECTIONS.has(t))) {
    return { verdict: 'AMBIGUO', reason: 'interjeição de hesitação/ironia' };
  }
  if (strong) return { verdict: 'SIM', reason: 'vocabulário fechado com afirmação forte' };
  if (soft) {
    const hasInterjection = tokens.some((t) => INTERJECTIONS.has(t) || THANKS.has(t));
    if (!hasInterjection && tokens.length <= SOFT_MAX_TOKENS) {
      return { verdict: 'SIM', reason: 'reconhecimento curto' };
    }
    return { verdict: 'AMBIGUO', reason: 'reconhecimento fraco em fala longa ou com interjeição' };
  }
  return { verdict: 'AMBIGUO', reason: 'sem afirmação' };
}

