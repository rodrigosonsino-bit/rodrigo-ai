/** Detector de frases proibidas (Fase 12, H12.1) — compartilhado entre os testes de consistência e de texto do cartão. */
export const QUALIFIER = 'com geração em nuvem desligada';

export const FORBIDDEN: ReadonlyArray<{ name: string; re: RegExp; sample: string }> = [
  { name: '100% local', re: /100\s?%\s*(local|locais|localmente)/i, sample: 'Voz 100% local.' },
  { name: 'sempre offline', re: /sempre\s+offline/i, sample: 'a conversa roda sempre offline' },
  { name: 'inteiramente offline', re: /inteiramente\s+offline/i, sample: 'tudo roda inteiramente offline' },
  { name: 'sem tráfego', re: /sem\s+tr[aá]fego/i, sample: 'sem tráfego de dados para terceiros' },
  { name: 'sem cobrança', re: /sem\s+cobran[cç]a/i, sample: 'Sem cobrança de API' },
  // só a promessa sobre serviço PAGO/externo: "o áudio não é enviado a nenhum serviço" é verdadeiro e desejado
  { name: 'nenhum serviço pago/externo', re: /nenhum\s+servi[cç]o\s+(pago|externo|de\s+terceiros)/i, sample: 'Nenhum serviço pago é utilizado.' },
  { name: 'chave de acesso', re: /chave\s+de\s+acesso/i, sample: 'nenhuma chave de acesso é usada' },
  { name: 'servidores externos', re: /servidores\s+externos/i, sample: 'sem chamada a servidores externos' },
  { name: 'never go out', re: /never\s+go\s+out/i, sample: 'data never go out.' },
  { name: 'zero external', re: /zero\s+external/i, sample: 'zero external deps.' },
  // F13a: a voz é sintetizada pelo Gemini por padrão — o painel ainda afirmava o contrário (achado em 2026-10-08)
  {
    name: 'síntese de voz local',
    re: /s[ií]ntese\s+de\s+voz\s+acontece[m]?\s+neste|voz\s+sint[eé]tica\s+funciona[m]?\s+neste/i,
    sample: 'captura, transcrição e síntese de voz acontecem neste computador'
  }
];

export interface Violation {
  line: number;
  pattern: string;
  text: string;
}

export function findViolations(content: string): Violation[] {
  const out: Violation[] = [];
  content.split('\n').forEach((text, i) => {
    if (text.toLowerCase().includes(QUALIFIER)) return;
    for (const { name, re } of FORBIDDEN) {
      if (re.test(text)) out.push({ line: i + 1, pattern: name, text: text.trim().slice(0, 140) });
    }
  });
  return out;
}

