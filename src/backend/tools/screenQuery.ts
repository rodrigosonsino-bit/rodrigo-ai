/**
 * Fase V (docs/phase-vision-v3.md §3.1, §3.2 e §10.1–10.2): quando uma fala é "sobre a tela" e quando ela autoriza mandar a
 * imagem ao Gemini. Decisões do usuário: o turno de tela só existe quando a fala CITA a tela ("Só quando eu disser"), e o
 * Gemini só vê a imagem por pedido explícito na própria fala ("Os dois, com escolha por voz").
 *
 * As duas funções são determinísticas e de mundo fechado: na dúvida, NÃO é tela e NÃO autoriza a nuvem.
 */

function norm(transcript: string): string {
  return transcript.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Referência explícita à tela. Palavras soltas ("isso", "esse erro") não bastam. */
const SCREEN_WORDS =
  /(?:^|[^\p{L}])(telas?|monitor(?:es)?|desktops?|[aá]reas? de trabalho|janelas?)(?=$|[^\p{L}])|o que (?:est[aá]|aparece) aqui na frente/u;

/**
 * A fala pede algo sobre a tela? O chamador precisa garantir antes que ela NÃO é um pedido de mutação
 * (`mightBeMutation`, §10.2) — "cria um lembrete para comprar a tela nova" é lembrete, não visão.
 */
export function mightBeScreenQuery(transcript: string): boolean {
  return SCREEN_WORDS.test(norm(transcript));
}

const GEMINI = String.raw`(?:o\s+)?g[eê]mini`;
const MARK = String.raw`(?:com|usa|use|usando|pelo|via|pergunta\s+(?:pro|ao|para\s+o)|manda\s+(?:pro|ao|para\s+o))\s+${GEMINI}`;
/** Marca em posição de comando: no início da fala... */
const MARK_AT_START = new RegExp(String.raw`^(?:e\s+)?${MARK}(?=$|[^\p{L}])`, 'u');
/** ...ou no fim, depois da pergunta ("olha minha tela com o Gemini", "..., manda pro Gemini"). */
const MARK_AT_END = new RegExp(String.raw`(?:^|[\s,;])${MARK}\s*[.!?]*$`, 'u');
/** Qualquer negação na fala vence (fail-closed): "não usa o Gemini", "sem o Gemini". */
const NEGATION = /(?:^|[^\p{L}])(n[aã]o|sem|nunca|nem|evita|evite)(?=$|[^\p{L}])/u;
/** Pergunta metalinguística sobre o comando não é o comando. */
const META = /^(?:o que (?:significa|quer dizer)|como assim|por ?que)(?=$|[^\p{L}])/u;
/** Marca entre aspas é citação. */
const QUOTED = /["'“”‘’«»][^"'“”‘’«»]*g[eê]mini[^"'“”‘’«»]*["'“”‘’«»]/u;

/** A fala DESTE turno autoriza mandar a imagem da tela ao Gemini? (Só a gramática; os canais de privacidade são à parte.) */
export function screenCloudAuthorized(transcript: string): boolean {
  const raw = transcript.normalize('NFC').toLowerCase();
  if (QUOTED.test(raw)) return false;
  const s = norm(transcript);
  if (!/g[eê]mini/u.test(s)) return false;
  if (NEGATION.test(s) || META.test(s)) return false;
  return MARK_AT_START.test(s) || MARK_AT_END.test(s);
}
