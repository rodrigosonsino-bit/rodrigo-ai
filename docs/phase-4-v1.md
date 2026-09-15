# Rodrigo AI Fase 4 v1 — Agentes Especialistas Reais (Geral / Teologia / Virtologia)

Data 2026-09-14. Primeira versão do plano, ainda não auditada.

## Objetivo e definição de pronto

A Fase 3 (aceita, `v0.2.0`) já classifica a intenção do usuário em `GERAL`/`TEOLOGIA`/`VIRTOLOGIA`/`AMBIGUO` e expõe essa decisão via evento `routing` — mas toda categoria é respondida pelo mesmo LLM geral, sem nenhuma especialização real. A Fase 4 fecha esse gap: cada rótulo passa a ter seu próprio system prompt (identidade, metodologia, limites), e o roteamento decidido na Fase 3 passa a ter efeito real na geração da resposta, não só na UI.

Escopo estritamente limitado a isso — nenhuma base de conhecimento externa, RAG, busca em documentos, ferramenta do sistema ou memória entre sessões (essas são Fases 5+, fora deste plano mesmo que pareçam naturais de adicionar aqui). "Pronto" exige: os 3 agentes implementados e registrados honestamente no `ExtensionRegistry`; roteamento real comprovado por teste automatizado (o system prompt que efetivamente chega ao motor de geração corresponde ao rótulo classificado); nenhuma regressão nos critérios B1-B8 (Fase 2) e C1-C6 (Fase 3); os 3 exemplos do roteiro validados com voz real (MLX real); e latência ainda dentro das metas já aceitas (≤4s mediana / ≤8s p95), mesmo com o system prompt maior.

## Fontes do conteúdo dos agentes (decisão já tomada, não uma pergunta em aberto)

O conteúdo de Teologia e Virtologia não estava documentado em nenhum lugar do código ou dos docs desta fase, e foi obtido nesta sessão diretamente do usuário, de duas fontes primárias que ele mesmo já mantém:

- **Teologia**: consolidado pelo ChatGPT (conta do usuário, projeto "Teologia e Ministério", conversa "IGREJA_TEOLOGIA.BIBLICA") cruzando memória de conversas anteriores reais sobre teologia, hermenêutica, exegese e pregação cristocêntrica. Documento completo salvo em `docs/research/teologia-profile-source.md`.
- **Virtologia**: consolidado via NotebookLM (notebook "VIRTOLOGIA", 101 fontes — livros, apostilas e transcrições de aulas de formação, incluindo *Fundamentos da Virtologia* e *Manual de Desenvolvimento Humano em Virtudes*, de Eduardo Casarotto). Documento completo salvo em `docs/research/virtologia-profile-source.md`.

Ambos os documentos-fonte são extensos (o de Teologia tem ~12 seções distinguindo posições estabelecidas de questões em aberto; o de Virtologia cobre toda a arquitetura teórica da metodologia). **Decisão de projeto**: os system prompts efetivamente usados no agente (seção "Prompts dos agentes" abaixo) são versões condensadas desses documentos-fonte, não o texto integral — motivo: o motor de voz roda um modelo local de 4B parâmetros (`Qwen3-4B-Instruct-2507-4bit`) com orçamento de contexto de `VOICE_LIMITS.MAX_CONTEXT_TOKENS = 4096` tokens compartilhado com até 8 turnos de histórico (`MAX_CONTEXT_TURNS`), e a Fase 3 já mediu que a latência-alvo (≤4s/≤8s) é sensível ao tamanho do prompt processado a cada turno. Colar os documentos-fonte inteiros (milhares de tokens cada) a cada turno estouraria esse orçamento e degradaria a latência que as Fases 2 e 3 já validaram como aceitável — não é uma simplificação por preguiça, é um limite técnico real do hardware/modelo local desta fase. Os documentos-fonte completos continuam versionados em `docs/research/` como referência para expandir os prompts no futuro (ex.: quando houver RAG na Fase 5) e para o próprio usuário revisar o que foi capturado.

## Decisões de projeto

**Nenhum comando novo no worker Python.** `scripts/worker/worker.py` já aceita `messages` arbitrárias em `handle_generate()` — o primeiro item da lista é o system prompt, escolhido inteiramente pelo lado Node. A Fase 4 não precisa tocar em `worker.py`; confirma a hipótese já registrada em `CLAUDE.md`.

**`IAgent` ganha um método `getSystemPrompt(): string`.** Os 3 agentes (Geral, Teologia, Virtologia) são objetos estáticos sem dependência externa (nenhum arquivo, rede ou processo) — `isAvailable()` sempre retorna `true`. Eles são registrados no `ExtensionRegistry` no mesmo lugar e sob a mesma condição que o `IVoiceProvider` já é registrado hoje (dentro de `createVoiceRuntime()`, só quando o runtime de voz está de fato disponível) — porque um agente só tem efeito prático dentro do pipeline `classify()` → `generate()`, que só existe quando a voz está disponível. Registrar os 3 sempre juntos, nunca parcialmente.

**Composição do system prompt final = identidade/domínio do agente + restrições técnicas de saída de voz, sempre nessa ordem.** As restrições de fala (nunca markdown, nunca emoji, responder em PT-BR, frases curtas e naturais) são um requisito técnico do pipeline de TTS, não uma característica de nenhum domínio — hoje elas vivem misturadas dentro de `VOICE_SYSTEM_PROMPT`, junto com a identidade genérica do agente Geral. A Fase 4 separa as duas coisas: cada agente contribui só com identidade+metodologia+limites; `SessionManager` sempre concatena por cima a mesma constante `VOICE_OUTPUT_CONSTRAINTS`, para qualquer rótulo.

**`AMBIGUO` usa o agente Geral.** Não existe (nem deveria existir) um "agente Ambíguo" — quando a classificação não consegue decidir entre categorias com confiança, a resposta mais segura é a do agente Geral, sem fingir uma especialização que a própria classificação disse não ter certeza. Isso muda a semântica de `handled` (ver abaixo).

**`handled` passa a ser `label !== 'AMBIGUO'`.** Na Fase 3, só `GERAL` tinha handler real, então `handled: label === 'GERAL'` era correto. Agora `TEOLOGIA` e `VIRTOLOGIA` também têm agente real — só `AMBIGUO` continua sem especialista dedicado (cai no Geral por decisão acima, não por ter um). A UI deixa de mostrar "especialista ainda não implementado" para Teologia/Virtologia — isso é exatamente o que esta fase entrega.

**Sem mudança no comando `classify` nem no seu prompt.** A classificação continua decidindo só a categoria; os agentes desta fase não retroalimentam o classificador.

## Prompts dos agentes (texto completo, não resumido para "depois")

Estes três textos são o conteúdo real de `getSystemPrompt()` de cada agente — condensados dos documentos-fonte (~170-185 palavras cada, ~220-260 tokens estimados), deixando margem confortável dentro do orçamento de `MAX_CONTEXT_TOKENS`.

**Geral** (substitui a identidade que hoje está embutida em `VOICE_SYSTEM_PROMPT`):
```
Você é o Rodrigo AI, um assistente de voz pessoal.
```

**Teologia**:
```
Você é o agente especialista em Teologia de Rodrigo Sonsino, pastor do Ministério Fonte
de Vida. Identidade: evangélico, bíblico, cristocêntrico, trinitário — não assuma rótulos
como reformado, arminiano, aliancista ou dispensacionalista sem confirmação explícita de
Rodrigo. Método: histórico-gramatical enriquecido por análise literária, histórica e
bíblico-teológica; situe sempre o Novo Testamento no judaísmo do Segundo Templo e nas
raízes veterotestamentárias antes de aplicar ao presente. Metanarrativa bíblica: Criação,
Queda, Israel, promessa, Messias, cruz e ressurreição, Espírito e Igreja, nova criação —
construa aplicações a partir desse movimento, nunca isolando versículos do contexto.
Escatologia pessoal de Rodrigo: pré-milenista e pós-tribulacionista, mas em temas
controversos apresente as alternativas com justiça. Autores de referência quando
pertinente: N. T. Wright, Richard Bauckham, Craig Keener, Grant Osborne, Michael Bird.
Nunca invente citações, versículos, posições ou bibliografia. Se a pergunta tocar tema
que Rodrigo não definiu (calvinismo versus arminianismo, batismo, dons espirituais,
governo eclesiástico), diga que a posição está em aberto e apresente as principais
leituras. Tom: rigor acadêmico em linguagem pastoral clara e falada.
```

**Virtologia**:
```
Você é o agente especialista em Virtologia, a metodologia de desenvolvimento humano de
Eduardo Casarotto que Rodrigo pratica e ensina. Virtudes são competências neurais do
lobo pré-frontal, desenvolvidas por Conhecimento mais Habilidade mais Atitude — nunca
trate virtude como valor moral, dogma religioso ou cobrança. Explique conceitos como
Aceitação, que é acolher ativamente o que não pode ser mudado no passado e agir no
presente sobre o que pode ser mudado, distinguindo isso do conformismo passivo. Use as
Faixas de Evolução (níveis de maturidade psíquica, do primitivo ao amor e caridade
plena) para explicar comportamentos, sempre com exemplos neutros de terceiros, nunca
rotulando ou cobrando moralmente quem pergunta. Nunca prometa ressignificar o passado —
a transformação vem pela Aceitação e pelo Perdão, construindo novos caminhos neurais,
não por catarse ou choro. Nunca valide vitimização; conduza sempre à autorresponsabilidade
e à ação prática. Deixe claro, quando relevante, que a Virtologia não é psicanálise
ortodoxa, não é religião nem moralismo, não é PNL ou motivação superficial, e nunca
substitui acompanhamento psiquiátrico ou médico em sofrimento psíquico grave — nesses
casos, recomende buscar ajuda profissional imediatamente.
```

## Arquitetura

### `src/shared/extensions/agents.ts` — interface estendida
```typescript
/**
 * Ponto de extensão para agentes especialistas (Fase 4). Cada agente é um objeto
 * estático (identidade + metodologia + limites) sem dependência externa — isAvailable()
 * sempre true. O efeito prático só existe dentro do pipeline classify()->generate(),
 * então o registro real acontece junto com o runtime de voz (ver voiceRuntime.ts).
 */
export interface IAgent {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  isAvailable(): boolean;
  getSystemPrompt(): string;
}
```

### `src/backend/agents/specialistAgents.ts` — novo arquivo
```typescript
import type { IAgent } from '../../shared/extensions/agents.js';
import type { OrchestratorLabel } from '../../shared/voiceProtocol.js';

export class AgentNotRegisteredError extends Error {}

const GERAL_PROMPT = 'Você é o Rodrigo AI, um assistente de voz pessoal.';

const TEOLOGIA_PROMPT =
  'Você é o agente especialista em Teologia de Rodrigo Sonsino, pastor do Ministério ' +
  'Fonte de Vida. Identidade: evangélico, bíblico, cristocêntrico, trinitário — não ' +
  'assuma rótulos como reformado, arminiano, aliancista ou dispensacionalista sem ' +
  'confirmação explícita de Rodrigo. Método: histórico-gramatical enriquecido por ' +
  'análise literária, histórica e bíblico-teológica; situe sempre o Novo Testamento no ' +
  'judaísmo do Segundo Templo e nas raízes veterotestamentárias antes de aplicar ao ' +
  'presente. Metanarrativa bíblica: Criação, Queda, Israel, promessa, Messias, cruz e ' +
  'ressurreição, Espírito e Igreja, nova criação — construa aplicações a partir desse ' +
  'movimento, nunca isolando versículos do contexto. Escatologia pessoal de Rodrigo: ' +
  'pré-milenista e pós-tribulacionista, mas em temas controversos apresente as ' +
  'alternativas com justiça. Autores de referência quando pertinente: N. T. Wright, ' +
  'Richard Bauckham, Craig Keener, Grant Osborne, Michael Bird. Nunca invente citações, ' +
  'versículos, posições ou bibliografia. Se a pergunta tocar tema que Rodrigo não ' +
  'definiu (calvinismo versus arminianismo, batismo, dons espirituais, governo ' +
  'eclesiástico), diga que a posição está em aberto e apresente as principais leituras. ' +
  'Tom: rigor acadêmico em linguagem pastoral clara e falada.';

const VIRTOLOGIA_PROMPT =
  'Você é o agente especialista em Virtologia, a metodologia de desenvolvimento humano ' +
  'de Eduardo Casarotto que Rodrigo pratica e ensina. Virtudes são competências neurais ' +
  'do lobo pré-frontal, desenvolvidas por Conhecimento mais Habilidade mais Atitude — ' +
  'nunca trate virtude como valor moral, dogma religioso ou cobrança. Explique conceitos ' +
  'como Aceitação, que é acolher ativamente o que não pode ser mudado no passado e agir ' +
  'no presente sobre o que pode ser mudado, distinguindo isso do conformismo passivo. ' +
  'Use as Faixas de Evolução (níveis de maturidade psíquica, do primitivo ao amor e ' +
  'caridade plena) para explicar comportamentos, sempre com exemplos neutros de ' +
  'terceiros, nunca rotulando ou cobrando moralmente quem pergunta. Nunca prometa ' +
  'ressignificar o passado — a transformação vem pela Aceitação e pelo Perdão, ' +
  'construindo novos caminhos neurais, não por catarse ou choro. Nunca valide ' +
  'vitimização; conduza sempre à autorresponsabilidade e à ação prática. Deixe claro, ' +
  'quando relevante, que a Virtologia não é psicanálise ortodoxa, não é religião nem ' +
  'moralismo, não é PNL ou motivação superficial, e nunca substitui acompanhamento ' +
  'psiquiátrico ou médico em sofrimento psíquico grave — nesses casos, recomende buscar ' +
  'ajuda profissional imediatamente.';

export class GeneralAgent implements IAgent {
  readonly id = 'geral';
  readonly name = 'Geral';
  readonly role = 'Conversação geral, matemática, factual e cotidiana';
  isAvailable(): boolean { return true; }
  getSystemPrompt(): string { return GERAL_PROMPT; }
}

export class TeologiaAgent implements IAgent {
  readonly id = 'teologia';
  readonly name = 'Teologia';
  readonly role = 'Bíblia, hermenêutica, exegese e pregação cristocêntrica';
  isAvailable(): boolean { return true; }
  getSystemPrompt(): string { return TEOLOGIA_PROMPT; }
}

export class VirtologiaAgent implements IAgent {
  readonly id = 'virtologia';
  readonly name = 'Virtologia';
  readonly role = 'Metodologia de desenvolvimento humano em virtudes (Eduardo Casarotto)';
  isAvailable(): boolean { return true; }
  getSystemPrompt(): string { return VIRTOLOGIA_PROMPT; }
}

/** Cria as 3 instâncias — usado por createVoiceRuntime() para registrar sempre juntas. */
export function createSpecialistAgents(): IAgent[] {
  return [new GeneralAgent(), new TeologiaAgent(), new VirtologiaAgent()];
}

const LABEL_TO_AGENT_ID: Record<OrchestratorLabel, string> = {
  GERAL: 'geral',
  TEOLOGIA: 'teologia',
  VIRTOLOGIA: 'virtologia',
  AMBIGUO: 'geral' // decisão de projeto: sem especialista para AMBIGUO, cai no Geral
};

/** Usado por SessionManager.runTurn() para escolher o agente do turno atual. */
export function selectAgentForLabel(label: OrchestratorLabel, agents: readonly IAgent[]): IAgent {
  const wantedId = LABEL_TO_AGENT_ID[label];
  const agent = agents.find((a) => a.id === wantedId);
  if (!agent) {
    throw new AgentNotRegisteredError(
      `Nenhum agente registrado com id "${wantedId}" para o rótulo ${label}.`
    );
  }
  return agent;
}
```

### `src/shared/extensions/registry.ts` — adiciona `registerAgent` e corrige `getModuleStatuses()`
```typescript
export class ExtensionRegistry {
  // ...campos existentes inalterados...

  /** Registrado pelo runtime de voz (Fase 4), sempre os 3 juntos, só quando disponível. */
  public registerAgent(agent: IAgent): void {
    this.agents.push(agent);
  }

  public getModuleStatuses(): readonly ModuleStatus[] {
    return [
      // ...'foundation' e 'voice' inalterados...
      {
        id: 'agents',
        name: 'Orquestrador e Agentes Especialistas',
        phase: 4,
        available: this.agents.length > 0,
        description:
          this.agents.length > 0
            ? `${this.agents.length} agentes especialistas ativos: ${this.agents.map((a) => a.name).join(', ')}.`
            : 'Nenhum agente especialista conectado — depende do runtime de voz (rode "npm run setup:voice").'
      },
      {
        id: 'tools',
        name: 'Ferramentas do Sistema',
        phase: 5,
        available: false,
        description: 'Integrações e ferramentas operacionais não habilitadas nesta fase (previsto para Fase 5).'
      }
    ];
  }
}
```
(Correção incidental: `tools` estava rotulado `phase: 4` desde a Fase 1 — número desatualizado agora que Fase 4 é ocupada pelos agentes; corrigido para `phase: 5`, coerente com o roteiro do usuário.)

### `src/backend/voice/voiceRuntime.ts` — registra os 3 agentes junto com o `ttsProvider`
```typescript
import { createSpecialistAgents } from '../agents/specialistAgents.js';
// ...

export function createVoiceRuntime(rootDir: string): VoiceRuntime {
  // ...checagens de disponibilidade inalteradas (RODRIGO_VOICE_DISABLE, venv, worker, manifest)...

  const engine = new MlxWorkerEngine({ pythonBin: venvPython, workerScript, hfCacheDir });
  const ttsProvider = selectVoiceProvider();
  ExtensionRegistry.getInstance().registerVoiceProvider(ttsProvider);

  const agents = createSpecialistAgents();
  for (const agent of agents) {
    ExtensionRegistry.getInstance().registerAgent(agent);
  }

  const audioStore = new AudioStore(path.join(rootDir, '.runtime', 'tmp'));
  const sessionManager = new SessionManager(engine, ttsProvider, audioStore, agents);

  return {
    available: true,
    sessionManager,
    audioStore,
    shutdown: async () => {
      await sessionManager.shutdownAll();
      await engine.shutdown();
    }
  };
}
```

### `src/backend/voice/sessionManager.ts` — mudanças completas
```typescript
import { selectAgentForLabel } from '../agents/specialistAgents.js';
import type { IAgent } from '../../shared/extensions/agents.js';

/**
 * Restrições técnicas de saída de voz — aplicadas a QUALQUER agente, sempre por cima
 * da identidade/metodologia dele. Isolado da identidade (que antes vinha junto em
 * VOICE_SYSTEM_PROMPT) porque é um requisito do pipeline de TTS, não do domínio.
 */
const VOICE_OUTPUT_CONSTRAINTS =
  'Suas respostas são sempre faladas em voz alta por um sintetizador de voz — nunca ' +
  'lidas como texto. Por isso: nunca use markdown (sem **negrito**, *itálico*, ' +
  '`código`, listas com marcadores ou links), nunca use emoji, nunca use abreviações ' +
  'visuais. Escreva números por extenso quando curtos (ex.: "quatro" em vez de "4") e ' +
  'mantenha respostas curtas e naturais, como numa conversa falada. Responda sempre em ' +
  'português do Brasil.';

// cleanTextForSpeech() inalterado.
// ActiveTurn, Session inalterados.

export class SessionManager {
  private readonly engine: VoiceEngine;
  private readonly ttsProvider: IVoiceProvider;
  private readonly audioStore: AudioStore;
  private readonly agents: readonly IAgent[]; // NOVO

  constructor(engine: VoiceEngine, ttsProvider: IVoiceProvider, audioStore: AudioStore, agents: readonly IAgent[]) {
    this.engine = engine;
    this.ttsProvider = ttsProvider;
    this.audioStore = audioStore;
    this.agents = agents;
  }

  // ...todo o resto inalterado até runTurn()...

  private async runTurn(session: Session, turn: ActiveTurn, audioPath: string): Promise<void> {
    try {
      // ...aquecimento, transcribe, emit transcript, classify — tudo inalterado...

      // Correção de semântica (Fase 4): TEOLOGIA e VIRTOLOGIA agora têm agente real.
      // Só AMBIGUO continua sem especialista dedicado (cai no Geral por decisão de
      // projeto, não porque tenha um "agente Ambíguo").
      const handled = label !== 'AMBIGUO';
      this.emit(session, { type: 'routing', turnId: turn.turnId, label, handled });

      this.emit(session, { type: 'state', state: 'falando' });

      // NOVO: o system prompt agora depende do rótulo classificado.
      const agent = selectAgentForLabel(label, this.agents);
      const systemPrompt = `${agent.getSystemPrompt()}\n\n${VOICE_OUTPUT_CONSTRAINTS}`;

      const messagesForEngine: ConversationMessage[] = [
        { role: 'system', content: systemPrompt },
        ...session.history
      ];

      await this.engine.generate(turn.turnId, turn.epoch, messagesForEngine, {
        // ...onSentence inalterado...
      });

      // ...resto do método inalterado (Promise.allSettled, turn_done, etc.)...
    } catch (err) {
      // ...inalterado...
    }
  }

  // ...synthesizeSentence, markPlayed, cancelTurn, endSession, resolveAudioPath, shutdownAll inalterados...
}
```

### `src/frontend/main.ts` — texto do indicador (só a função de formatação muda)
```typescript
const AGENT_DISPLAY_NAMES: Record<'GERAL' | 'TEOLOGIA' | 'VIRTOLOGIA', string> = {
  GERAL: 'Geral',
  TEOLOGIA: 'Teologia',
  VIRTOLOGIA: 'Virtologia'
};

function formatAgentIndicator(label: OrchestratorLabel, handled: boolean): string {
  if (!handled) {
    // Só AMBIGUO cai aqui agora — Teologia e Virtologia são `handled: true` na Fase 4.
    return 'Classificado como: AMBÍGUO (respondido pelo agente Geral)';
  }
  return `Agente: ${AGENT_DISPLAY_NAMES[label as 'GERAL' | 'TEOLOGIA' | 'VIRTOLOGIA']}`;
}
```
Chamado no mesmo lugar que hoje monta o texto de `#voice-agent-indicator`; reset em novo turno/erro/fim de sessão continua idêntico à Fase 3 (nenhuma mudança nesse mecanismo).

## Testes

**Novo: `src/backend/__tests__/agents.test.ts`**
- `selectAgentForLabel('GERAL', agents)` → retorna o `GeneralAgent`.
- `selectAgentForLabel('TEOLOGIA', agents)` → retorna o `TeologiaAgent`.
- `selectAgentForLabel('VIRTOLOGIA', agents)` → retorna o `VirtologiaAgent`.
- `selectAgentForLabel('AMBIGUO', agents)` → retorna o `GeneralAgent` (mesma instância que `'GERAL'` resolveria).
- `selectAgentForLabel('TEOLOGIA', [])` → lança `AgentNotRegisteredError`.
- `createSpecialistAgents()` retorna exatamente 3 agentes com ids `'geral'`, `'teologia'`, `'virtologia'`, todos `isAvailable() === true`.

**Atualizado: `src/backend/__tests__/voice.test.ts`**
- Helper de setup passa a construir `SessionManager` com `createSpecialistAgents()` (não mais 0 argumentos extras).
- Teste novo: para cada rótulo (`classificationToReturn = 'TEOLOGIA'`, depois `'VIRTOLOGIA'`, depois `'GERAL'`), depois de rodar um turno completo, `fakeEngine.generateCalls[0].messages[0].content` contém a substring identificadora certa (`'Teologia de Rodrigo Sonsino'`, `'Virtologia'`, `'Rodrigo AI, um assistente de voz pessoal'`, respectivamente) — prova que o roteamento tem efeito real na geração, não só no evento de UI.
- Teste atualizado: `handled` para `AMBIGUO` continua `false`; `handled` para `TEOLOGIA` e `VIRTOLOGIA` agora é `true` (era `false` na Fase 3 — mudança de contrato documentada e intencional, não regressão).
- Testes de cancelamento/preempção da Fase 3 (C5) continuam válidos sem mudança — não dependem do conteúdo do system prompt.

**Regressão**: `npm test` completo (Fase 1 B1-B8 + Fase 2 + Fase 3 C1-C6) sem falhas.

## Verificação com áudio real (MLX real, matriz do roteiro)

| # | Frase | Rótulo esperado | O que a resposta real deve demonstrar |
|---|---|---|---|
| 1 | "Quanto é 17% de 850?" | GERAL | Resposta direta, sem linguagem teológica/virtológica — mesmo comportamento da Fase 3. |
| 2 | "Faça uma análise exegética de Hebreus 5" | TEOLOGIA | Resposta situa o texto no método histórico-gramatical/bíblico-teológico (não uma resposta genérica de cultura bíblica geral) — evidência de que o system prompt de Teologia foi realmente usado. |
| 3 | "Explique a Aceitação dentro da Virtologia" | VIRTOLOGIA | Resposta usa a distinção Aceitação-ativa x Conformismo-passivo e/ou o vocabulário próprio da Virtologia (competência do Ego, Faixas de Evolução) — não uma resposta genérica de autoajuda. |

Cada caso: gravar a transcrição da resposta falada (já capturada pelo evento `transcript`/pipeline de teste manual usado nas Fases 2-3) como evidência no relatório de aceite, igual ao padrão já usado para C2 da Fase 3.

## Critérios de aceite

- **C1** Fases 1-3 preservadas: `npm run typecheck`, `npm run build`, `npm test` sem regressão; todos os critérios B1-B8 (Fase 2) e C1, C2, C4, C5, C6 (Fase 3) continuam válidos. C3 da Fase 3 (latência) é reavaliado como C5 abaixo, não simplesmente herdado, porque o tamanho do prompt mudou.
- **C2** Os 3 agentes (`geral`, `teologia`, `virtologia`) estão registrados no `ExtensionRegistry` sempre juntos quando o runtime de voz está disponível; `GET /api/health` (ou o endpoint que expõe `getModuleStatuses()`) reporta o módulo `agents` como `available: true` com os 3 nomes, e `available: false` quando a voz está desabilitada — nunca um estado parcial.
- **C3** Roteamento real comprovado por teste automatizado: para cada rótulo classificado, o `content` do primeiro item de `messages` passado a `engine.generate()` corresponde ao agente certo (teste descrito acima). `AMBIGUO` usa o mesmo prompt que `GERAL`.
- **C4** `handled` segue a nova semântica (`label !== 'AMBIGUO'`) e a UI exibe `"Agente: Teologia"` / `"Agente: Virtologia"` / `"Agente: Geral"` para rótulos tratados e `"Classificado como: AMBÍGUO (respondido pelo agente Geral)"` para `AMBIGUO` — verificado com teste automatizado E verificação visual manual na UI real (mesmo padrão das Fases 2-3).
- **C5** Latência par-a-par: mesmo corpus/benchmark das Fases 2-3 (`npm run bench:voice`), agora com os system prompts reais de Teologia e Virtologia (não só o Geral, que é o mais curto) — mediana e p95 continuam dentro de ≤4s/≤8s. Se não continuarem, o prompt condensado precisa ser encurtado ainda mais antes de aceitar a fase — não se aceita a fase com regressão de latência não documentada.
- **C6** Os 3 exemplos do roteiro (tabela acima) validados com voz real (MLX real, não mock), evidência registrada no relatório de aceite.
- **C7** Nenhuma capacidade nova além de prompt especializado + roteamento real: sem busca em documentos, sem RAG, sem ferramentas, sem memória entre sessões — revisão de escopo explícita no relatório final, mesmo padrão do C6 da Fase 3.

## Sequência

1. Auditoria adversarial deste v1 (Codex CLI e/ou Antigravity CLI, modo read-only/plan) — só implementar depois de aprovado sem achados de gravidade alta pendentes.
2. Implementação, nesta ordem: `src/shared/extensions/agents.ts` (interface) → `src/backend/agents/specialistAgents.ts` (novo) → `src/shared/extensions/registry.ts` (`registerAgent` + `getModuleStatuses` corrigido) → `src/backend/voice/voiceRuntime.ts` (registro) → `src/backend/voice/sessionManager.ts` (consumo do agente escolhido) → `src/frontend/main.ts` (indicador).
3. Testes automatizados: `agents.test.ts` novo, `voice.test.ts` atualizado (construção do `SessionManager` com agentes + novo teste de roteamento real + `handled` atualizado). `npm test` completo sem regressão.
4. Benchmark par-a-par de latência com os 3 prompts reais (C5) — se estourar a meta, ajustar o tamanho do prompt condensado e remedir antes de prosseguir.
5. Verificação com áudio real dos 3 exemplos do roteiro (C6), evidência registrada.
6. Relatório de aceite (`docs/implementation-phase-4.md`), mesmo formato dos relatórios anteriores, e confirmação do usuário com microfone real — nenhuma fase anterior foi aceita sem esse passo, esta não pula essa etapa. Bump de versão para `0.3.0` (`package.json`, `types.ts`, `health.ts`, `index.html`, testes) só depois de C1-C7 confirmados com evidência real, não antes.
