# Fase 15 — Orquestrador Autônomo e Coordenador de Subagentes por Voz (plano v3)

Data: 2026-10-09 (conteúdo revisado em 2026-10-10 contra r2 e r3). Autor: Orquestrador. Estado: **Aprovado com ressalvas**.
Substitui `docs/phase-15-v2.md`. Motivo: reconciliação direta contra `docs/audits/phase-15-plan-audit-r1.md`
(§11 deste documento) encontrou 1 achado CRÍTICO e 1 achado ALTO da r1 que a v2 não resolveu, apesar de a
v2 se autodeclarar "Aprovado para implementação". Esta v3 resolve os dois, mais o achado MÉDIO da ponte
OpenClaw (especificação de protocolo), e acrescenta uma trava estrutural para o achado ALTO 3 da r1 (que a
v2 resolveu só em prosa, sem garantia de tipo).

> Atualização 2026-10-10 (r2): os achados da auditoria da rodada 2 (`docs/audits/phase-15-plan-audit-r2.md`)
> foram incorporados — ver §12. Veredicto da r2: **APROVÁVEL COM RESSALVAS** (nenhum achado novo ALTO/CRÍTICO).

> Atualização 2026-10-10 (r3): os achados da auditoria da rodada 3 (`docs/audits/phase-15-plan-audit-r3.md`)
> foram incorporados — ver §13. Veredicto da r3: **APROVÁVEL COM RESSALVAS** (os 5 achados da r2 resolvidos;
> 2 MÉDIOS e 4 BAIXOS novos, nenhum ALTO/CRÍTICO). Estado passa de "NÃO aprovado" para **Aprovado com
> ressalvas** — critério do projeto ("achados altos não resolvidos bloqueiam a aprovação") está atendido.
> Ressalva externa mantida: o transporte da ponte OpenClaw (§4.2) continua dependendo de decisão do usuário.

---

## 1. Contexto, Ancoragem no Código e Objetivos

A Fase 15 transforma o `SessionManager` (`src/backend/voice/sessionManager.ts`) num **coordenador de
subagentes**. Quando o usuário faz um pedido com vários passos, o orquestrador:

1. Decompõe o pedido numa sequência de tarefas de subagentes.
2. Delega a execução para o subagente adequado via interface `ISubAgent`.
3. Garante **cancelamento cooperativo via `AbortSignal`** no barge-in (interrupção por fala em <= 350ms).
4. Garante a **fronteira de segurança e confirmação** — ver §3 (trava estrutural, novo nesta v3).
5. Mantém um registro auditável `ExecutionTrace` para responder por voz à pergunta *"O que você fez?"*.
6. Respeita um **orçamento de chamadas/tempo por turno** — ver §6 (novo nesta v3).
7. Classifica toda leitura autônoma como **local** ou **externa/nuvem** antes de executá-la — ver §5 (novo
   nesta v3).

Partes desta seção, a interface `ISubAgent` e o `ExecutionTrace` já existem como código real, não commitado:
`src/backend/agents/subAgent.ts`, `src/backend/agents/adapters.ts`, `src/backend/agents/openClawSubAgent.ts`.
Essa implementação foi escrita em cima da v2 e **precede a auditoria desta v3** — ver §10 (o que o código já
tem e o que falta) antes de tratá-la como pronta.

---

## 2. Assinatura da Interface `ISubAgent`, Cancelamento e Confirmação Estrutural

Em `src/backend/agents/subAgent.ts` (já existe; esta seção especifica um campo novo):

```ts
export interface SubAgentTaskRequest {
  taskId: string;
  turnId: string;
  prompt: string;
  isMutation: boolean;
  /** NOVO (v3): obrigatório quando isMutation=true. Minerado só por SessionManager depois de
   * confirmação de voz real (markPlayed() + classificador determinístico = 'SIM'). Nenhum outro
   * chamador deve conseguir montar este valor. */
  confirmationToken?: string;
  context?: Record<string, unknown>;
}

export interface SubAgentTaskResult {
  success: boolean;
  output: string;
  error?: string;
  /** NOVO (v3, achado r2 N2): discriminante estrutural do contrato síncrono-vs-assíncrono.
   *  Substitui o parsing de string mágica "__ASYNC__:<taskId>" em `output` — este campo é o
   *  contrato real, imune a refatorações que normalizem/trunquem `output` antes do TTS. */
  kind?: 'final' | 'async_deferred';
  /** NOVO (v3, achado r2 N2): presente (e só faz sentido) quando kind === 'async_deferred'. */
  asyncTaskId?: string;
}

export interface ISubAgent {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  runTask(req: SubAgentTaskRequest, signal: AbortSignal): Promise<SubAgentTaskResult>;
}
```

### 2.1 Por que isto é necessário (achado 3 da r1, ainda aberto na v2)

A v2 já descrevia, em prosa, que "a confirmação por voz é obtida ANTES da chamada ao subagente mutante".
Mas o código real hoje (`src/backend/agents/adapters.ts`, classe `ToolSubAgent.runTask`) **não verifica
`req.isMutation` em nenhum ponto** — ele chama `this.tool.execute(...)` incondicionalmente. A garantia
depende inteiramente de o chamador (`SessionManager`) nunca esquecer de checar a confirmação antes de
invocar `coordinator.get(id).runTask(...)` — e essa integração (Fatia 4, ainda não feita) é exatamente o
código que ainda vai ser escrito. Prosa não impede um esquecimento futuro; um campo obrigatório no tipo,
sim.

**Contrato novo, obrigatório em `ToolSubAgent.runTask` (`adapters.ts`):**

```ts
async runTask(req: SubAgentTaskRequest, signal: AbortSignal): Promise<SubAgentTaskResult> {
  if (req.isMutation) {
    if (!req.confirmationToken) {
      return {
        success: false,
        output: '',
        error: 'Mutação bloqueada: nenhum confirmationToken presente (achado 3 da auditoria r1 da F15).'
      };
    }
    // NOVO (v3, achado r2 N4): frescor — exige que o token embuta o turnId atual. Sem isto, um
    // token de turno anterior reusado por engano passaria pela checagem de presença sozinha.
    if (!req.confirmationToken.startsWith(`${req.turnId}:`)) {
      return {
        success: false,
        output: '',
        error: 'Mutação bloqueada: confirmationToken não corresponde ao turno atual (achado r2 N4).'
      };
    }
  }
  // ... resto do runTask atual
}
```

Isto não é segurança criptográfica contra um atacante — é uma trava estrutural contra um erro de
integração futuro: qualquer código que tente chamar um `ToolSubAgent` mutante sem ter passado pela
confirmação de voz recebe um erro alto e imediato, em vez de silenciosamente mutar sem confirmação. O
valor do token pode ser tão simples quanto `` `${turnId}:${pendingMutation.askedAt}` ``, gerado por
`SessionManager` no mesmo lugar onde hoje ele monta `confirmed === 'SIM'`
(`sessionManager.ts`, bloco "Fase 5c: consumo de pendingMutation", em torno da linha 501) — o ponto não é
o valor ser imprevisível, é ele só existir depois da confirmação real.

**Frescor do token (novo — achado r2 N4):** a checagem de presença acima, sozinha, não garante que o token
pertence à mutação *deste* turno. O contrato passa a exigir também que `req.confirmationToken` comece com
`` `${req.turnId}:` `` — uma linha que fecha o caso de um token de turno anterior reusado por engano, sem
custo e sem se promover a "segurança criptográfica" (continua sendo trava anti-esquecimento, não
anti-atacante).

**Nonce do token (novo — achado r3 N6):** se `turnId` for sequencial ou baseado em timestamp previsível, a
previsibilidade do valor completo do token enfraquece a trava (ameaça modelada como erro de integração, não
atacante ativo — ver acima). Custo zero para elevar a barreira: incluir um nonce curto gerado na hora,
`` `${turnId}:${askedAt}:${crypto.randomUUID().slice(0,8)}` ``, mantendo a checagem de frescor por
`startsWith(\`${turnId}:\`)` inalterada (o nonce vai depois do primeiro `:`, não antes).

---

## 3. Subagentes Suportados na F15

1. **Especialistas Internos (`SpecialistSubAgent`):** encapsula `Geral`/`Teologia`/`Virtologia` (e
   `Neurociência`, quando a F16 estiver fechada) em `src/backend/agents/specialistAgents.ts`. **Nota de
   reconciliação:** o código hoje em `adapters.ts` assume que todo `IAgent` tem `.domain` e
   `.processQuery(query)`; a interface real (`src/shared/extensions/agents.ts`) tem `id`, `name`, `role`,
   `isAvailable()`, `getSystemPrompt()` — nenhum dos dois campos assumidos existe. Isto não é um defeito
   desta v3 (nenhuma versão do plano, v1/v2/v3, jamais especificou esse formato) — é um desvio da
   implementação que precisa ser corrigido no código antes de uma auditoria de código, não de plano.
2. **Ferramentas Mutantes e de Estado (`StateToolSubAgent`):** encapsula `LembreteTool`, `NotaTool`,
   `MemoriaTool` de `src/backend/tools/mutatingTools.ts`, com a trava do §2.1.
3. **Ponte OpenClaw (`OpenClawSubAgent`):** ver especificação completa no §4 (substitui a frase única da v2).

---

## 4. Ponte OpenClaw — Protocolo, Timeout e Modo de Falha (substitui a v2 §1 item 3)

### 4.1 O que a v2 dizia e por que não bastava (achado 6 da r1, ainda aberto)

V2: *"Comunica-se com os agentes e subagentes do OpenClaw via API local com timeout estrito de 15s."* Sem
protocolo, sem autenticação, sem comportamento de falha especificado. O código real já escrito
(`src/backend/agents/openClawSubAgent.ts`) confirma a lacuna: quando `openClawClient` não é passado (o
caso hoje — nada em `SessionManager` constrói um real), o subagente devolve **sucesso falso fixo**
(`[OpenClaw ${name}] Processado com sucesso: ${prompt}`), e não existe nenhum timeout implementado no
arquivo — ele só repassa o `AbortSignal` externo, nunca cria um próprio.

### 4.2 Transporte — a confirmar antes da implementação, não inventado aqui

O mecanismo exato pelo qual este processo Node (`Rodrigo AI`, rodando em `127.0.0.1:3000`) alcança uma
sessão/agente do OpenClaw **não foi verificado neste plano** e não deve ser assumido. Duas hipóteses
plausíveis, nenhuma confirmada:
(a) uma chamada HTTP local ao gateway do OpenClaw, autenticada por um token de gateway lido de variável de
ambiente (padrão `RODRIGO_OPENCLAW_GATEWAY_URL` + `RODRIGO_OPENCLAW_GATEWAY_TOKEN`, seguindo a mesma
convenção de `.env.example` já usada pelo projeto);
(b) invocar um CLI/MCP local do OpenClaw via `child_process`, análogo ao que este próprio processo de
agente já faz com `notebooklm`/`deepseek`/`agy`.
**Antes de implementar a Fatia 3 (abaixo), confirmar com o usuário qual das duas opções é real** — não
escrever código contra uma suposição.

### 4.3 Dois modos de chamada (short-task síncrono, long-task assíncrono)

Tarefas de leitura rápida (ex.: "qual o horário de tal evento") cabem num timeout curto. Tarefas que a
ambição maior do usuário já deixou claras — navegar um site, mexer no Drive, controlar outra máquina,
postar numa rede social — plausivelmente excedem qualquer timeout curto. Um único timeout fixo de 15s
serve mal os dois casos: ou é curto demais para a segunda classe, ou longo demais para travar a
conversa na primeira.

```ts
export interface OpenClawTaskHandle {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export class OpenClawSubAgent implements ISubAgent {
  // ...
  async runTask(req: SubAgentTaskRequest, signal: AbortSignal): Promise<SubAgentTaskResult> {
    const SHORT_TIMEOUT_MS = 15_000; // leitura rápida, resposta síncrona
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), SHORT_TIMEOUT_MS);
    const combined = /* AbortSignal.any([signal, timeoutController.signal]) — Node 20+ */;
    try {
      const result = await this.openClawClient.invokeShort(req.prompt, combined);
      return { success: true, output: result, kind: 'final' };
    } catch (err) {
      if (timeoutController.signal.aborted) {
        // Não tenta decidir "deu certo ou não" — dispara como tarefa longa e devolve
        // ao SessionManager um resultado que vira fala explícita: "isso vai levar mais
        // tempo, te aviso quando terminar" (nunca inventa sucesso).
        const handle = await this.openClawClient.invokeLongAsync(req.prompt);
        // NOVO (achado r2 N2): nada de string mágica em `output`; o discriminante é estrutural.
        return { success: true, output: '', kind: 'async_deferred', asyncTaskId: handle.taskId };
      }
      return { success: false, output: '', error: this.describeFailure(err), kind: 'final' };
    } finally {
      clearTimeout(timer);
    }
  }

  private describeFailure(err: unknown): string {
    // NUNCA "processado com sucesso" quando não houve conexão real (correção do mock atual).
    return `Não consegui falar com o OpenClaw agora (${err instanceof Error ? err.message : 'erro desconhecido'}).`;
  }
}
```

O discriminante `kind === 'async_deferred'` (+ `asyncTaskId`) é um contrato interno **estrutural** entre
`OpenClawSubAgent` e `SessionManager` (achado r2 N2 — antes era o prefixo de string `__ASYNC__:<taskId>` em
`output`, frágil a qualquer sanitizador de texto antes do TTS): ao recebê-lo, o orquestrador fala uma frase
de progresso (ex.: "isso vai demorar um pouco, continuo
trabalhando nisso") em vez de tratar como resposta final, registra o `taskId` no `ExecutionTrace` com
status `pending`, e liga um poller (`openClawClient.pollStatus(taskId)`, intervalo de 5-10s, teto de
**10 minutos** — ponto de partida conservador, achado r3 N1; ajustável depois que o transporte do §4.2 for
confirmado, mas não bloqueia a implementação do poller nem a aprovação deste plano) que, ao concluir,
injeta o resultado como uma fala nova fora de turno (mesma mecânica que já existe para notificações de
lembrete).

**Risco conhecido, registrado e não resolvido nesta v3:** se o processo do Rodrigo AI reiniciar enquanto
uma tarefa assíncrona está pendente, o `taskId` e o poller se perdem — o OpenClaw pode terminar a tarefa
sem que ninguém informe o usuário. Isto foi observado de verdade nesta sessão (uma auditoria em
background própria morreu sem aviso quando o processo supervisor reiniciou). Mitigação mínima para a
Fatia 3: persistir tarefas assíncronas pendentes em `data/` (mesmo padrão de `JsonStore` já usado para
lembretes) e, na subida do servidor, verificar o status de qualquer tarefa pendente salva antes de
descartá-la. Mitigação completa (retomar o poller automaticamente) fica fora de escopo desta fase.

**Schema de persistência (novo — achado r3 N2):** o registro em `data/` segue o campo mínimo abaixo, escrito
de forma atômica (temp + rename, mesmo padrão já usado pelo `JsonStore` para lembretes):

```ts
interface PendingAsyncTask {
  taskId: string;
  prompt: string;
  capability: string;        // domínio declarado do OpenClawSubAgent que originou a tarefa (§4.4)
  startedAt: string;         // ISO — usado pelo descarte de 6h abaixo
  turnId: string;
  confirmationToken?: string; // presente só se a tarefa original era uma mutação
}
```

Índice de recuperação na subida: ler todos os registros do arquivo (não há volume que justifique lookup
indexado — o teto de 2 tarefas assíncronas simultâneas do §6 limita o tamanho). Limpeza: todo registro é
removido do arquivo assim que a tarefa é verificada como concluída, falha, ou descartada por idade — nunca
acumula indefinidamente.

**Comportamento exato na subida (novo — achado r2 N1):** o plano não pode deixar aberto o que acontece
quando o processo volta. Especificação para a Fatia 3:
1. Ao subir, ler as tarefas assíncronas pendentes persistidas; **descartar (sem falar nada) qualquer uma
   com mais de `RODRIGO_ASYNC_TASK_TTL_HOURS` horas** de idade (env var nova, padrão **6h** — achado r3 N3;
   valor assumido como aproximação do TTL padrão de tarefas do gateway OpenClaw, não confirmado contra a
   documentação dele, por isso configurável em vez de fixo no código).
2. Para as demais, verificar o status real no OpenClaw antes de qualquer fala.
3. Se concluída, falar um resumo **datado e marcado como resultado de tarefa anterior** (nunca re-injetar
   como se fosse a conclusão de uma pergunta nova nem como se o turno ainda estivesse ativo), e registrar
   no `ExecutionTrace`.
4. A pergunta original que motivou a tarefa **não é re-entregue ao LLM** — só o status é verificado. Se o
   `taskId` não existir mais no OpenClaw, eis o caso de falha: falar honestamente que a tarefa se perdeu
   num reinício, sem inventar resultado.

### 4.4 Escopo de capacidade — não é tudo-ou-nada

Em vez de uma única instância genérica de `OpenClawSubAgent`, o coordenador registra **uma instância por
domínio de capacidade declarado** (`capabilities: readonly string[]`, campo que a interface já tem):
por exemplo `openclaw_web` (pesquisa/navegação), `openclaw_drive` (quando a F18 existir),
`openclaw_social` (quando decidido — ver nota de escopo no fim deste documento). Cada instância pode ter
seu próprio timeout e sua própria exigência de confirmação (ex.: `openclaw_social` deveria ser tratado
como mutação mesmo para "ler", dado que uma ação de postar é irreversível e pública — ver nota de escopo).
Isto não resolve a pergunta de "quem impede o agente do lado do OpenClaw de fazer mais do que o
declarado" — essa é uma responsabilidade compartilhada com a configuração do próprio OpenClaw, fora do
controle deste processo Node, e deve ser documentada como tal, não prometida como garantia.

---

## 5. Classificação da Leitura Autônoma: Local vs. Externa/Nuvem (novo — resolve achado 4 da r1)

A v2 não endereçou isto, apesar de a r1 ter marcado como achado ALTO e de `docs/roadmap-2026-10-09.md`
§3 (escrito no mesmo dia que a v2) registrar explicitamente: *"'tudo' foi dito em 2026-10-02, mas isso
inclui busca na web (saída de dado pra nuvem) e ainda precisa de um plano nominal... com aprovação
explícita"*. Uma v2 que se declara "aprovada para implementação" sem resolver uma pendência que o
roteiro oficial do mesmo dia lista como aberta está, por definição, incompleta.

| Categoria | Exemplos | Autonomia | Controle |
|---|---|---|---|
| **Leitura Local Autônoma** | lembretes/notas/memórias (`data/`), BM25 sobre `docs/research/` | Imediata, sem confirmação | Já existe (`RODRIGO_SEND_KNOWLEDGE` para o corpus; dados locais não têm canal de privacidade porque nunca saem da máquina) |
| **Leitura Externa/Nuvem** | busca na web, qualquer API externa que não seja o próprio Gemini já autorizado (geração/intenção/TTS/visão) | **Nunca autônoma por padrão** — requer o canal ligado explicitamente | Novo canal `RODRIGO_WEB_SEARCH` em `src/backend/privacy.ts`, seguindo exatamente o padrão de `cloudVision`/`cloudTts` (mestre `RODRIGO_CLOUD` + sub-canal + motivo exposto em `/api/privacy`) |

```ts
// src/backend/privacy.ts — adição ao PrivacyConfig existente
readonly webSearch: boolean; // RODRIGO_WEB_SEARCH — leitura externa/nuvem autônoma (busca web via F15). Padrão 0.
```

```ts
export function webSearchEffective(cfg: PrivacyConfig): boolean {
  return cfg.cloud && cfg.webSearch;
}
```

Com isto, o coordenador da F15 só permite ao `OpenClawSubAgent` (capacidade `openclaw_web`) executar uma
leitura autônoma de busca quando `webSearchEffective(privacy)` for verdadeiro — do contrário, a resposta é
"a busca na web está desligada; quer que eu ligue?" (mesmo padrão de `GENERATION_DISABLED_TEXT`).

**Integração confirmada (novo — achado r3 N4):** `RODRIGO_WEB_SEARCH` entra em `envToPrivacyConfig()` e em
`/api/privacy` exatamente como `cloudVision`/`cloudTts` hoje (mesmo arquivo `privacy.ts`, mesma função,
mesmo endpoint) — não é um canal com tratamento especial. H15.6 cobre o bloqueio; a exposição correta do
motivo em `/api/privacy` é verificada manualmente na Fatia 1/4 antes de considerá-la pronta, já que H15.6
testa apenas o bloqueio, não a resposta do endpoint.

---

## 6. Orçamento e Limites por Turno (novo — resolve achado 2 [CRÍTICO] da r1, ausente na v2)

A r1 pediu números concretos, não a reafirmação do requisito. Os valores abaixo são um **teto inicial
para calibrar com o próprio H15.1 (40 cenários multi-passo), não uma medição já feita** — nenhum deles
foi validado contra dado real ainda, e o critério de aceite H15.5 é justamente essa validação:

| Limite | Valor inicial proposto | Onde se aplica |
|---|---|---|
| Chamadas a subagentes por turno | 6 | `SubAgentCoordinator`, contador por `turnId` |
| Orçamento de tempo total de orquestração por turno | 60s (fora do tempo de fala/TTS) | `SessionManager`, relógio desde a primeira delegação |
| Timeout por chamada síncrona à ponte OpenClaw | 15s (ver §4.3) | `OpenClawSubAgent` |
| Teto de tarefas assíncronas simultâneas por sessão | 2 | `SubAgentCoordinator` |

Estourar qualquer um destes limites encerra a orquestração do turno com uma fala honesta ("não consegui
terminar isso dentro do tempo/dos passos previstos; aqui está o que já fiz") e registra o estouro no
`ExecutionTrace`, nunca falha em silêncio nem inventa conclusão.

**Procedimento de recalibração (novo — achado r2 N3):** os tetos da tabela são ponto de partida, não
verdade. Se H15.1 falhar por estouro de orçamento em >10% dos 40 cenários, recalibrar a tabela do §6 e
re-rodar H15.5 — registrando os valores antigos e novos na reconciliação, para que o número final seja
medido, não escolhido.

**Recalibração no sentido contrário (novo — achado r3 N5):** o procedimento acima só dispara se os tetos
forem baixos demais. H15.7 abaixo mede o caso oposto — tetos altos demais, que permitem cadeias longas,
latência e custo desnecessários sem nunca estourar.

**Critério de aceite novo:**

| ID | Critério | Quem mede |
|---|---|---|
| H15.5 | 200 cenários adversariais de orçamento (cadeias de delegação propositalmente longas) — zero caso em que o app ultrapassa os limites da tabela acima sem avisar o usuário por voz | Agente |
| H15.7 | Nos mesmos 40 cenários de H15.1, média de chamadas a subagentes por turno <= 3 (50% do teto da tabela acima) — mede se o teto não está excessivamente folgado (achado r3 N5) | Agente |

---

## 7. Fatias de Implementação da Fase 15 (atualizado)

- **Fatia 1:** Interface `ISubAgent` (com `confirmationToken`) + `SubAgentCoordinator` + `AbortSignal` +
  `ExecutionTrace` + contador de orçamento (§6). *(Já existe código parcial — falta o campo
  `confirmationToken` e o contador.)*
- **Fatia 2:** Adaptadores dos especialistas internos e ferramentas de estado — **corrigir primeiro** a
  divergência de `adapters.ts` contra a `IAgent` real (§3, nota 1) antes de prosseguir. **Pré-condição
  verificável (achado r2 N5): `npx tsc -p tsconfig.server.json --noEmit` limpo** — o harness não roda com a
  fronteira de tipos quebrada, então isto vira critério, não boa intenção.
- **Fatia 3:** Ponte OpenClaw real — confirmar transporte (§4.2), implementar os dois modos de chamada
  (§4.3, com o discriminante estrutural `kind`/`asyncTaskId`), escopo por capacidade (§4.4), persistência
  mínima de tarefa assíncrona pendente e o comportamento exato de subida do §4.3 (achado r2 N1).
- **Fatia 4:** Integração no `SessionManager` — gatekeeper de mutação que gera o `confirmationToken`
  (com checagem de frescor por `turnId`, achado r2 N4), checagem de `webSearchEffective` antes de delegar
  leitura externa, contador de orçamento do turno, barge-in em <= 350ms.
- **Fatia 5:** Suíte de testes de estresse H15 (40 cenários multi-passo, 200 cenários de segurança/
  orçamento, cancelamento), com o procedimento de recalibração do §6 (achado r2 N3).

---

## 8. Tabela de Critérios de Aceite (Harness H15) — atualizada

| ID | Critério |
|---|---|
| H15.1 | 40 cenários multi-passo >= 90% concluídos corretamente |
| H15.2 | Zero mutação executada sem `confirmationToken` válido em 200 cenários adversariais |
| H15.3 | Cancelamento por barge-in em <= 350ms p95 sem tarefas órfãs |
| H15.4 | Rastreabilidade total: o app responde por voz *"o que você fez?"* usando o `ExecutionTrace`, incluindo tarefas assíncronas pendentes |
| H15.5 | 200 cenários de orçamento — zero estouro silencioso (ver §6) |
| H15.6 | Leitura externa/nuvem (busca web) nunca ocorre com `RODRIGO_WEB_SEARCH=0`, em 50 cenários adversariais |
| H15.7 | Média de chamadas a subagentes por turno <= 3 nos cenários de H15.1 (ver §6, achado r3 N5) |

---

## 9. O que ainda fica em aberto nesta v3 (honesto, não escondido)

- O transporte real da ponte OpenClaw (§4.2) depende de uma resposta do usuário — não escrever código da
  Fatia 3 antes disso.
- O escopo exato de quais domínios de capacidade (§4.4) existem além de `openclaw_web` depende de decisões
  ainda não tomadas (Drive = F18, redes sociais = sem fase definida ainda, "próxima máquina" = sem leitura
  decidida). Esta v3 só define o MECANISMO (uma instância por capacidade); não lista todas as capacidades
  futuras.
- A persistência completa de tarefas assíncronas através de um restart do processo (§4.3) está fora de
  escopo — só a mitigação mínima (registrar e verificar na subida) está dentro.

---

## 10. O que o código já escrito (não commitado) tem e o que falta, verificado agora

| Arquivo | Tem | Falta |
|---|---|---|
| `src/backend/agents/subAgent.ts` | `ISubAgent`, `SubAgentCoordinator`, `ExecutionTrace` — compatível com esta v3 | Campo `confirmationToken`, contador de orçamento (§6) |
| `src/backend/agents/adapters.ts` | Estrutura de `SpecialistSubAgent`/`ToolSubAgent` | Corrigir `.domain`/`.processQuery` (não existem em `IAgent`); adicionar a checagem de `confirmationToken` (§2.1); `ToolSubAgent` chama `execute()` sem argumentos no ramo `else` (`tsc` acusa `Expected 2 arguments, but got 0`) |
| `src/backend/agents/openClawSubAgent.ts` | Esqueleto de `ISubAgent`, fallback quando não conectado | Tudo do §4: timeout real, modo assíncrono, `describeFailure` honesto (hoje finge sucesso), escopo por capacidade |
| `src/backend/__tests__/phase15.test.ts` | 1 teste de cancelamento por `AbortSignal` | Cobertura de H15.2, H15.5, H15.6 |

---

## 11. Reconciliação achado-por-achado contra `docs/audits/phase-15-plan-audit-r1.md`

| Achado r1 | Gravidade | Status na v2 | Status nesta v3 |
|---|---|---|---|
| 1. `ISubAgent` sem `AbortSignal` | CRÍTICO | Resolvido | Mantido |
| 2. H15.5 ausente | CRÍTICO | **Não resolvido** | Resolvido (§6, §8) |
| 3. Gatekeeper de mutação pode ser pós-execução | ALTO | Resolvido só em prosa | Resolvido com trava de tipo (§2) |
| 4. Leitura autônoma sem classificar saída pra nuvem | ALTO | **Não resolvido** | Resolvido (§5) |
| 5. Ausência de ancoragem `file:line` | ALTO | Parcial | Esta v3 cita arquivo:linha em cada seção nova |
| 6. Protocolo da ponte OpenClaw incompleto | MÉDIO | Não resolvido | Resolvido onde possível; transporte exato depende de decisão do usuário (§4.2, §9) |
| 7. Rastreabilidade sem especificação | MÉDIO | Resolvido | Mantido, estendido para tarefas assíncronas |

---

## 12. Reconciliação contra `docs/audits/phase-15-plan-audit-r2.md` (incorporada em 2026-10-10)

| Achado r2 | Gravidade | Onde foi tratado nesta v3 |
|---|---|---|
| N1. Persistência pós-restart sem comportamento definido na subida | MÉDIO | §4.3, "Comportamento exato na subida" (descartar >6h, resumo datado, nunca re-injetar, falha honesta se o `taskId` sumiu) + Fatia 3 |
| N2. Contrato `__ASYNC__:<taskId>` frágil (string mágica em `output`) | MÉDIO | §2: `SubAgentTaskResult.kind`/`asyncTaskId`; §4.3 usa o campo, não o prefixo |
| N3. Tetos de orçamento sem procedimento de recalibração | BAIXO | §6, "Procedimento de recalibração" + Fatia 5 |
| N4. `confirmationToken` só checava presença, não frescor | BAIXO | §2.1: checagem de `` `${turnId}:` `` no contrato + Fatia 4 |
| N5. Divergência de `IAgent` sem critério que trave | BAIXO | §7 Fatia 2: `tsc --noEmit` limpo como pré-condição verificável |

Nenhum achado ALTO/CRÍTICO novo — veredicto r2 **APROVÁVEL COM RESSALVAS**, mantido. A única pendência
externa (transporte da ponte, §4.2) continua dependente de decisão do usuário e não é tratável em plano.

---

## 13. Reconciliação contra `docs/audits/phase-15-plan-audit-r3.md` (incorporada em 2026-10-10)

Placar r2 (confirmado pela r3): os 5 achados N1-N5 da r2 estão **RESOLVIDOS** com mecanismo real.

| Achado r3 | Gravidade | Onde foi tratado nesta v3 |
|---|---|---|
| N1. Intervalo de polling e teto de duração indefinidos ("N minutos") | MÉDIO | §4.3: teto padrão de 10 min, ajustável após confirmação do transporte, não bloqueia a Fatia 3 |
| N2. Schema de persistência de tarefas assíncronas pendentes não especificado | MÉDIO | §4.3, "Schema de persistência": campos `PendingAsyncTask`, escrita atômica, índice por leitura completa, limpeza ao concluir/falhar/descartar |
| N3. Limite de 6h para descarte silencioso sem justificativa | BAIXO | §4.3: `RODRIGO_ASYNC_TASK_TTL_HOURS` (env, padrão 6h), valor declarado como suposição não confirmada |
| N4. `RODRIGO_WEB_SEARCH` sem integração demonstrada em `envToPrivacyConfig`/`/api/privacy` | BAIXO | §5, "Integração confirmada": mesmo padrão de `cloudVision`/`cloudTts`; verificação manual na Fatia 1/4 |
| N5. Recalibração de orçamento só cobre teto baixo demais, não alto demais | BAIXO | §6: novo H15.7 (média de chamadas/turno <= 3) + §8 |
| N6. `confirmationToken` previsível se `turnId` for previsível | BAIXO | §2.1: nonce curto adicionado ao token, sem alterar a checagem de frescor por prefixo |

Nenhum achado ALTO/CRÍTICO novo — veredicto r3 **APROVÁVEL COM RESSALVAS**. Critério do projeto ("achados
altos não resolvidos bloqueiam a aprovação") atendido: **Estado desta v3 passa a Aprovado com ressalvas.**
A única pendência que permanece fora do controle do plano é o transporte real da ponte OpenClaw (§4.2),
que depende de decisão do usuário antes de a Fatia 3 começar — as Fatias 1, 2, 4 e 5 não dependem dela.
