/**
 * F11 — gera amostras sintéticas de fala (texto) via agentes gratuitos (opencode).
 * Uso: node scripts/f11-gen-dataset.mjs <dev|heldout> <modelo>
 * Só texto sintético: nada de docs/research, .env ou dado pessoal sai daqui.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [split, model, onlyPrefix = '', outName = ''] = process.argv.slice(2);
if (!split || !model) { console.error('uso: <dev|heldout> <modelo>'); process.exit(1); }
const mult = split === 'dev' ? 1.6 : 1;
const OUT = `docs/audits/f11/raw/${outName || split}.jsonl`;

const STYLE = (process.env.F11_PERSONA ? process.env.F11_PERSONA + ' ' : '') + 'Português do Brasil falado, como transcrição de fala informal de um usuário conversando com um assistente de voz: ' +
  'frases curtas a médias, variadas em vocabulário e estrutura, com gírias, hesitações ocasionais, sem pontuação perfeita. ' +
  'Não repita estruturas. Não numere.';

const CATS = {
  // intenção — mutação
  LEMBRETE_CRIAR: [12, 'o usuário pede para o assistente CRIAR um lembrete de um compromisso/tarefa (com ou sem horário), de formas variadas: "me lembra de", "não deixa eu esquecer", "bota um aviso pra", "me avisa"'],
  LEMBRETE_EDITAR: [12, 'o usuário pede para CORRIGIR/TROCAR o TEXTO do lembrete que acabou de criar (não o horário)'],
  LEMBRETE_APAGAR: [12, 'o usuário pede para APAGAR/CANCELAR o lembrete mais recente'],
  NOTA_CRIAR: [12, 'o usuário pede para ANOTAR/GUARDAR uma ideia ou observação livre como nota'],
  NOTA_EDITAR: [12, 'o usuário pede para CORRIGIR/TROCAR o texto da nota mais recente'],
  NOTA_APAGAR: [12, 'o usuário pede para APAGAR a nota mais recente'],
  MEMORIA_GUARDAR: [12, 'o usuário pede para o assistente GUARDAR um fato ou preferência sobre o PRÓPRIO usuário (nome, gosto, restrição)'],
  MEMORIA_EDITAR: [12, 'o usuário pede para CORRIGIR um fato sobre ele que o assistente guardou antes'],
  MEMORIA_ESQUECER: [12, 'o usuário pede para o assistente ESQUECER/APAGAR o fato mais recente guardado sobre ele'],
  // intenção — tempo
  HORA: [25, 'o usuário pergunta a HORA atual de formas coloquiais variadas ("que horas são", "já é meio-dia?", "tá tarde?", "me diz as horas")'],
  DATA: [25, 'o usuário pergunta o DIA/DATA/dia da semana de hoje de formas coloquiais variadas'],
  // negativos
  NENHUMA_COMUM: [45, 'conversa comum sem pedir lembrete/nota/memória nem hora/data: perguntas de conhecimento, teologia, desabafos, pedidos de explicação, conversa fiada'],
  NENHUMA_DIFICIL: [45, 'frases que PARECEM pedido mas NÃO são: citam "lembrar", "anotar", "apagar", "hora", "dia", "data", "nota" em outro sentido (ex.: "eu lembro que você falou", "o dia do juízo final", "quanto dura a hora do culto?", "o que é um lembrete na psicologia", "nota dez na prova", "a hora da verdade chegou")'],
  // confirmação (o usuário acabou de ouvir "Posso criar/apagar/alterar ...? Diga sim ou não")
  CONF_SIM: [60, 'resposta que CONFIRMA claramente uma ação proposta, de formas naturais e coloquiais ("pode ser", "manda ver", "isso aí", "claro que sim", "fechou", "pode mandar bala")'],
  CONF_NAO_CLARA: [60, 'resposta que NEGA/CANCELA claramente uma ação proposta ("não", "não quero", "cancela", "nada disso", "pode esquecer")'],
  CONF_NAO_INDIRETA: [45, 'resposta que NEGA de forma indireta/coloquial, sem a palavra "não" sozinha ("melhor deixar pra depois", "nem, depois eu faço", "deixa quieto", "agora não", "mudei de ideia", "tá errado, refaz")'],
  CONF_AMBIGUA: [45, 'resposta que NÃO decide: hesitação, dúvida, pergunta de volta, pedido de repetir ("hum", "não sei", "pera aí", "depende", "como assim?", "repete", "qual era mesmo?")'],
  CONF_RUIDO: [40, 'fala fora de contexto ou ruído transcrito: mudança de assunto, outro pedido, fragmentos de fala alheia, preenchedores ("que horas são", "ah", "tá chovendo aí?", "alô")']
};

const CONTEXT_FRAME = "Contexto obrigatório: o assistente acabou de perguntar 'Posso fazer isso? Diga sim ou não.' e a frase gerada é a RESPOSTA CURTA DO USUÁRIO a essa pergunta (o usuário NÃO é quem executa a tarefa; não use 'já resolvo', 'já faço'). Frases de 1 a 8 palavras, naturais, como falaria um adulto comum. ";

function run(cat, n, desc, attempt = 1) {
  const N = Math.round(n * mult);
  const answerFrame = cat.startsWith('CONF_') && cat !== 'CONF_RUIDO' ? CONTEXT_FRAME : '';
  const prompt = `Gere exatamente ${N} frases DISTINTAS em ${STYLE}\nCategoria: ${desc}.\n` +
    `${answerFrame}Responda SOMENTE com um array JSON de strings, sem texto antes ou depois, sem cercas de código.`;
  return new Promise((resolve) => {
    // stdin 'ignore': opencode run fica pendurado esperando EOF se stdin for um pipe aberto.
    const child = model === 'hermes'
      ? spawn('docker', ['exec', 'hermes', 'hermes', '-z', prompt], { stdio: ['ignore', 'pipe', 'ignore'] })
      : spawn('opencode', ['run', prompt, '-m', model], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
    child.on('close', () => {
      clearTimeout(timer);
      const m = stdout.match(/\[[\s\S]*\]/);
      let arr = [];
      try { arr = JSON.parse(m[0]).filter((s) => typeof s === 'string' && s.trim()); } catch {}
      console.log(`[${split}] ${cat}: pedido=${N} recebido=${arr.length} tentativa=${attempt}`);
      if (arr.length === 0 && attempt < 3) return resolve(run(cat, n, desc, attempt + 1));
      resolve(arr.map((text) => ({ text: text.trim(), label: cat, split, gen: model })));
    });
  });
}

const entries = Object.entries(CATS).filter(([c]) => (onlyPrefix.startsWith('!') ? !c.startsWith(onlyPrefix.slice(1)) : c.startsWith(onlyPrefix)));
const rows = [];
const queue = [...entries];
await Promise.all([0, 1, 2].map(async () => {
  while (queue.length) { const [c, [n, d]] = queue.shift(); rows.push(...await run(c, n, d)); }
}));
const seen = new Set();
const uniq = rows.filter((r) => { const k = r.text.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
fs.writeFileSync(OUT, uniq.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`gravado ${uniq.length} em ${OUT}`);
