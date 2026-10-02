# Prompt de continuação — Rodrigo AI → orquestrador de voz autônomo (gerado em 2026-10-02)

> **Como usar:** abra uma sessão nova em `/Users/rodrigosonsino/Documents/Codex/2026-09-11/referenced-chatgpt-conversation-this-is-an/outputs/rodrigo-ai`
> e cole este arquivo inteiro como primeira mensagem (ou peça: "leia docs/prompt-proxima-sessao-2026-10-02.md e execute").
> Tudo abaixo foi escrito para quem **não tem acesso à conversa anterior**. Os fatos da seção 2 foram
> gerados por comando em 2026-10-02; **reexecute os comandos antes de confiar neles** — o repositório pode ter mudado.

---

## 0. Missão

Levar o Rodrigo AI de "assistente de voz pessoal confiável" até **orquestrador de voz autônomo e coordenador
inteligente de agentes e subagentes**, fase por fase. Cada fase tem um objetivo claro e mensurável; uma equipe
de agentes e subagentes (implementação, teste, auditoria) **itera até o objetivo ser atingido** — com as
salvaguardas da seção 6, que existem para o laço nunca fingir que terminou nem queimar crédito sem convergir.

Você é o **orquestrador de fase**: planeja, delega, verifica de forma independente e responde pelo resultado.
Saída de subagente é rascunho, nunca produto.

---

## 1. Regras duras (valem em todas as fases)

1. **Plano → auditoria de plano → implementação → verificação independente → auditoria de código → medição → commit.**
   Nenhuma mudança não-trivial pula etapa. Mudança trivial e localizada (constante, texto de UI) pode ir direta,
   mas declare isso.
2. **Fronteira de privacidade.** Captura de áudio, STT (`mlx-whisper`), classificação (Qwen3 MLX), ferramentas,
   memória e TTS são **locais, loopback-only**. A **única** exceção aprovada é a geração de texto pelo Gemini
   (Fase 10a). Qualquer nova saída de dado para a nuvem (inclusive voz nativa, TTS em nuvem, outro LLM, busca web
   autônoma) exige plano explícito **e aprovação do usuário** — nunca em silêncio. Áudio bruto nunca sai da máquina.
3. **Nunca mandar `docs/research/` a terceiros** (perfil teológico pessoal e material de Virtologia). Nem `.env`.
   Para auditar com Hermes/Kimi/DeepSeek/Codex: copiar só código e documentos de plano.
4. **Ações que mutam estado** (lembrete/nota/memória) só executam após confirmação real de que o usuário **ouviu**
   a pergunta (`markPlayed()`). Ações financeiras, mensagens externas e irreversíveis continuam **fora de escopo**.
5. **Não aceitar achado de auditor nem relato de subagente sem verificar no código/por comando.** Já houve falso
   positivo disprovado por teste empírico (Fase 7) e outro por leitura de código (Fase 10a, type hints). Registre
   no commit quando um achado cair.
6. **Honestidade sobre dívida:** critério que não passou é registrado como não passou, com número — nunca
   "aprovado" por cansaço. Mesma disciplina das Fases 5b/5c.
7. **Verificação do harness antes de acreditar na evidência:** valide scripts de medição contra uma amostra
   independente conhecida (lição da "repetição fantasma" da Fase 4).
8. **Economia de crédito:** trabalho braçal vai para os agentes gratuitos (seção 5); você só faz o que exige
   julgamento. Antes de disparar qualquer rodada cara, consulte o Jev (ver memória) e escreva em uma frase o que a
   rodada deve achar que a anterior não achou.

---

## 2. Estado verificado em 2026-10-02 (classe: VERIFICADO AGORA — reexecute)

| Fato | Comando que o gerou | Resultado |
|---|---|---|
| Branch / remoto | `git branch --show-current; git remote -v \| wc -l` | `main`, **0 remotos** (sem backup/push possível) |
| HEAD | `git log --oneline -1` | `50a7b1a` — Endurece fix de barge-in |
| Árvore de trabalho | `git status --short` | só `?? .claude/` (launch.json do preview) e `?? docs/rodrigo-ai-architecture-digest-2026-09-28.md` |
| Versão | `grep '"version"' package.json` | `0.3.0` |
| Testes TS | `npm test` (fora do sandbox) | **197/197** passando, 0 falhas |
| Typecheck/build | `npm run typecheck && npm run build` | limpos |
| Testes Python do worker | `.runtime/.venv/bin/python3 scripts/worker/test_*.py` | 4 arquivos passaram em 2026-09-29; `worker.py` não mudou desde — **reexecute** |
| Modelo de geração | `grep 'model="gemini' scripts/worker/worker.py` | `gemini-flash-latest` (linha 698) |
| Teto de saída | `grep '^MAX_TURN_TOKENS' scripts/worker/worker.py` | `160` — **herdado do modelo local, ainda não revisado** |
| Chave Gemini | `awk -F= '/^GEMINI_API_KEY=/{print length($2)}' .env` | presente (53 chars); `.env` está no `.gitignore` (linha 3) |
| Fases implementadas | `git log --oneline \| grep Fase` | 1–4, 5a/b/c, 6 (lembretes agendados), 7 (memória entre sessões), 8 (editar item), 9 (recorrência), 10a (Gemini) |
| `CLAUDE.md` cobre 6–9? | `grep -c -iE "Phase (6\|7\|8\|9)\b" CLAUDE.md` | `1` → **desatualizado**: as Fases 6–9 não estão documentadas lá (só em `docs/phase-N-v2.md`) |
| Hermes (job agendado) | `ps`, `/tmp/hermes-bargein-lean.log` | job PID 50659 ainda rodava; log vazio na checagem — **pode já ter terminado; `/tmp` é efêmero** |

**Stack (do `CLAUDE.md`, relido hoje):** Node/TS backend sem framework (`src/backend/`), frontend TS vanilla +
Vite, worker Python MLX persistente (`scripts/worker/worker.py`, NDJSON via stdio), Qwen3-4B-Instruct-2507-4bit
(classificação/detecções), whisper-small-mlx (STT), TTS `say` voz `Felipe (Enhanced)` (Kokoro disponível),
`ExtensionRegistry` (`IVoiceProvider`, `IAgent`, `ITool`/`IMutatingTool`), agentes `GERAL/TEOLOGIA/VIRTOLOGIA`
(+`AMBIGUO`→Geral), recuperação BM25 local de `docs/research/`, memória em `memorias.json`, lembretes com
`ReminderScheduler` + recorrência.

**Dados medidos nesta semana (não generalizar):**
- Primeira geração real ponta a ponta com Gemini (`flash-lite`, 1 amostra): TTFC **7,57 s** (alvo da meta H10 era
  mediana ≤4,0 s / p95 ≤8,0 s fim-de-fala→primeiro áudio — **não medida formalmente**).
- `gemini-flash-latest` devolveu **503 "high demand" persistente** em ~15 tentativas ao longo de >1 h em 2026-09-28/29.
  Reverificar: pode ter normalizado ou ser limitação do tier da chave.
- Benchmark de qualidade (4 perguntas, mesmo prompt de sistema, Gemini lite vs GPT via Codex CLI): qualidade
  próxima; **não** é comparação justa (lite é o tier mais fraco). Não justifica trocar de provedor.

---

## 3. Suposições herdadas (classe: NÃO VERIFICADAS por mim — verifique antes de agir)

Vieram da consulta ao Codex CLI (`docs/codex-consulta-fim-fixo-2026-09-29.md`). O Codex **leu** o código mas **não
executou testes**. Dos 5 pontos que ele levantou como "mudam a avaliação", só o nº 3 (barge-in/`markPlayed`) foi
verificado e corrigido. Os demais são **candidatos a achado**, a verificar nas fases indicadas:

- O produto é híbrido e a UI/`README` ainda podem afirmar "sem chamadas externas/custos/offline" (parcialmente corrigido; reauditar) → F12.
- Histórico enviado ao Gemini pode conter falas de ferramentas; `session.history` é cortado por **nº de mensagens**, e
  `markPlayed()` grava **uma entrada por frase** — não equivale a "oito rodadas" → F13.
- Classificação usa a fala isolada (continuações como "e como isso se aplica?" perdem contexto) → F13.
- O servidor anuncia `ouvindo` após a síntese, não após o fim do playback → F11/F13.
- Notas não têm ferramenta de **consulta**; editar/apagar recai no item **mais recente**; não há reagendamento; "amanhã às dez"
  pode cair em "amanhã" às nove com a hora no texto residual → F14.
- Recuperação de conhecimento: 2 arquivos de perfil, 1 trecho de até 1.200 caracteres, sem saber se há resposta no corpus;
  memória injeta as 10 mais recentes (não as mais relevantes) → F16.
- `osascript` bem-sucedido não prova que a notificação foi vista → F14.
- SenseVoice (Alibaba, via plugin do DeepSeek) **não cobre PT** (conhecimento do model card, não reverificado) → descartado
  como STT; candidatos a avaliar se STT virar gargalo: `whisper-large-v3-turbo` (MLX), Parakeet v3.
- Tokenizer do Gemini ≠ Qwen3: `max_output_tokens=160` não equivale ao teto do modelo local (ressalva Hermes rodada 3) → medir em F13.

---

## 4. Combinado com o usuário (classe: CITADO LITERALMENTE — não é verificável por comando)

- Decisões da Fase 10a (via AskUserQuestion): "Google (Gemini)"; "Substituição completa"; "Erro honesto, sem resposta (Recomendado)"; "Sim, topo (Recomendado dado 10a)" (privacidade do prompt); "gemini-flash-latest (Recomendado)".
- Queixa de qualidade após teste real: "voz ainda bem robótica e bem burro ainda" e "preciso de mais inteligencia, mais naturalidade de conversa ..."
- Sobre o modelo: "volte para o latest" (reverteu o contorno temporário para `flash-lite`).
- Definição do fim: "defina um fim fixo definido o melhor app desse tipo do mercado" → consulta Codex (6 fases, `docs/codex-consulta-fim-fixo-2026-09-29.md`).
- Processo do fix de barge-in: "já implementa direto e depois o hermes cli audita"; depois "use o kimi cli para auditar" (não existe `kimi` CLI; usado Kimi K3 via `opencode`); depois "aplique as duas" (sugestões opcionais da auditoria).
- Pedido que gerou este documento: "faça um prompt para uma próxima sessao com contexto, memoria e as proximas fases para finalizar o app para que ele seja um orquestrador de voz autonomo e um coordenador inteligente de agentes e subagentes. cada fase precisa ter um objetivo claro e agentes e subagentes de auditoria e implemetacao e teste só param quando o objetivo for atingido."
- Voz robótica: o TTS é decisão da Fase 2 (comparou `say` compacta, `Luciana (Enhanced)`, `Felipe (Enhanced)`, Kokoro em 2026-09-14 e escolheu Felipe). ElevenLabs foi apresentado como opção **paga/nuvem**; **não decidido**.

---

## 5. Memória e lições operacionais

**Memórias persistidas** (`~/.claude/projects/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/memory/`):
- *Consultar o Jev em ambiguidade e estatística* — gatilho automático (ambiguidade, estatística, limiar, priorização, "vale o custo?"). API `https://api.typesafe.ai/v1/systemone`, chave em `TYPESAFE_API_KEY` (`~/.zshenv`), ~0,8 s; **agrupar perguntas numa chamada só**; pergunta `noul` com **um lado só**.
- *Hermes audita código, Codex audita plano* — escolha o auditor pelo artefato. Plano não acha teste vácuo, por construção; código implementado precisa de auditoria de código antes de a fase fechar.

**Ferramentas de agente (fatos de hoje, e as armadilhas que custaram tempo):**
| Papel | Ferramenta | Invocação | Armadilha real |
|---|---|---|---|
| Implementação | `agy` | `agy -p "<prompt>" --mode accept-edits --effort high --dangerously-skip-permissions --print-timeout 60m < /dev/null > log 2>&1 &` | já falhou por "broken pipe" de rede do backend dele; reenviar apontando as mudanças parciais. **Nunca aceitar o autorrelato: reexecutar typecheck/build/test.** |
| Auditoria de plano | `agy --mode plan`, `codex exec -s read-only --skip-git-repo-check -o out.txt -` (prompt via stdin) | `codex update` já feito (0.158); modelo padrão funciona | dentro de `while read`, o `codex exec` **consome o stdin do loop** → sempre `< /dev/null` e leia o arquivo por outro fd |
| Auditoria de código | Hermes: `docker exec hermes hermes -z "<prompt>"` | só enxerga `~/hermes-workspace` | **falhou 3× com "allowance for chatting without signing in"** em prompts grandes (cota anônima do Nous, apesar de `hermes auth status nous` = logged in; chamada pequena passa). Use prompt **enxuto e autocontido** (diff + trechos inline, "não leia arquivos"). Não abrir `~/.hermes/.env`/`auth.json`. |
| Auditoria/raciocínio | Kimi K3 | `opencode run "<prompt>" -m nvidia/moonshotai/kimi-k3 < /dev/null` (**não existe CLI `kimi`**) | funciona com prompt autocontido; ~minutos |
| Alternativa | DeepSeek (NIM) / `mcp__llm-cli__deepseek_ask` | ver skill `auditoria-plano-codex` | — |
| Decisão barata | Jev | ver memória | limiar ≠ inteligência: calibrar contra casos reais |

**Pegadinhas do ambiente (todas silenciosas):**
- Sob o sandbox do Bash: MLX/Metal ("No Metal device"), bind de socket (`listen EPERM`), socket do Docker e `pgrep` falham. **Re-rodar com `dangerouslyDisableSandbox: true`** antes de investigar lógica. Não combinar com `allowed_domains`.
- `node --test` + teste que **falha** não chama o teardown → o timer de idle de 10 min segura o processo e parece travado. Mate o processo e restaure arquivos mutados manualmente (aconteceu hoje no teste de mutação; sempre `git status` depois).
- `source .env` quebra em `SAY_VOICE=Felipe (Enhanced)` (parênteses): leia a chave com `awk -F= '/^KEY=/{print $2}'`.
- Preview pelo browser pane só suporta **uma porta**: usar `npm run build && npm start` (`.claude/launch.json` existe, não commitado). **Microfone é bloqueado no painel** → teste de voz real só no navegador do usuário (`http://localhost:3000`).
- Monitores em background com `timeout` curto morrem sem o trabalho terminar; use `3600000`.
- `timeout` do GNU não existe no macOS.

---

## 6. Protocolo de fase (o laço de agentes e subagentes)

Cada fase roda esta equipe. Você orquestra; marque no plano qual ferramenta fez cada papel e **qual auditor viu o quê** (regra de rotação: da 3ª rodada em diante, troque de auditor).

| Papel | Quem | Entrega |
|---|---|---|
| **Escopo** | você + `AskUserQuestion` | decisões de produto que só o usuário toma (1 a 2 rodadas; 5 só se mexer em privacidade) |
| **Planejador** | você | `docs/phase-N-v1.md` ancorado em código real (file:line), com critérios H1…Hn |
| **Auditor de plano** | Codex/agy/Kimi (read-only) | achados no formato `ACHADO/EVIDÊNCIA/GRAVIDADE/CONFIANÇA/AÇÃO`; log em `docs/audits/` |
| **Implementador** | `agy --mode accept-edits` (subagentes Claude `general-purpose` p/ trabalho braçal) | working tree, sem commit |
| **Testador** | agente de teste + você | testes novos **com prova de mutação** (reverter só o fix → teste falha ✖ → restaurar) |
| **Verificador independente** | você, do zero | `typecheck`, `build`, `npm test`, testes Python, spot-check do código crítico |
| **Auditor de código** | Hermes (prompt enxuto) e/ou Kimi/DeepSeek | achados sobre o código entregue; **verificar cada um antes de aplicar** |
| **Medidor** | scripts de matriz + **o usuário** (voz real) | numeradores e denominadores, amostra de desenvolvimento ≠ amostra reservada |

**Condição de parada da fase:** *todos* os critérios H da fase passam com números registrados **e** nenhum achado
CRÍTICA/ALTA aberto **e** `CLAUDE.md`/docs/UI coerentes **e** commit feito. Falhou algum → volte ao papel que
corrige a causa (não ao início), e repita.

**Salvaguardas (adicionadas por mim — o usuário pode remover explicitamente):**
1. **Circuit breaker:** 3 ciclos corrigir→reauditar sem convergir → trocar de auditor; mais 2 sem convergir → **parar e
   escalar ao usuário** com o que foi tentado. "Só param quando o objetivo for atingido" não pode virar laço infinito pago.
2. **Critério que depende de voz humana não se autocertifica.** Agentes entregam o harness (script, lista de frases,
   planilha) e **aguardam** o usuário gravar/falar; a fase só fecha com a medição dele.
3. **Parar ≠ escolher critério mais fácil.** Mudar um alvo H no meio da fase exige registro e aprovação do usuário.

---

## 7. Fases (continuam a numeração; 10b — Jev como provedor — segue registrada em `docs/phase-10-option-typesafe-jev.md`, não implementada)

> Metas numéricas abaixo são **propostas** (vêm da consulta Codex ou minhas), não resultados existentes. Calibre contra
> os casos reais antes de virarem promessa.

### F11 — Autorização e resultado confiáveis
**Objetivo:** o sistema distingue com segurança pedido, confirmação, execução e sucesso; nunca afirma ter feito o que não fez.
**Aceite:** H11.1 intenção — 200 falas inéditas, precisão e recall ≥95% (hora/data e mutações, separados); H11.2 confirmação —
≥95% de 100 afirmativas naturais aceitas e **zero ações** em 300 negações/ambiguidades/ruídos; H11.3 reprodução e cancelamento —
100 cenários de interrupção/atraso/repetição, nenhuma frase interrompida registrada como ouvida e nenhuma pergunta incompleta
habilitando execução (continuação do fix `23db5be`/`50a7b1a`; verificar `ouvindo` vs fim de playback); H11.4 resultado
verdadeiro — 100 cenários de falha/não suportado, zero "salvei/apaguei/agendei" falso.
**Agentes:** Impl (agy) para redesenho do detector de confirmação Camada 1 e gate; Teste: gerador de matriz sintética +
harness de áudio real; Auditor de código: Hermes (enxuto) + Kimi; Medidor: usuário. **Dívidas reabertas aqui:** H-mutação 76,5%
(Fase 5c), H-confirmação 61,1% (5c), H11 5b 75%.
**Decisão do usuário necessária:** reabrir as dívidas aceitas de 5b/5c (a consulta Codex diz que impedem declarar a 1.0).

### F12 — Privacidade condizente com a promessa
**Objetivo:** a UI e os docs dizem exatamente o que fica local e o que vai ao Gemini, com controle do que pode sair.
**Aceite:** H12.1 nenhuma tela/doc afirma ausência de nuvem/custo com geração externa ligada; modo efetivo visível antes da conversa;
H12.2 100 turnos instrumentados com dados sintéticos identificáveis → zero áudio e zero conteúdo marcado "só local" em requisições
externas (**inclui histórico/resumos derivados, não só o bloco de memória**); H12.3 50 tarefas locais funcionam sem internet,
geração indisponível é dita com clareza, **sem fallback para outro provedor**; H12.4 encerrar sessão limpa áudios temporários, e após
queda a próxima inicialização limpa resíduos; logs sem conversa/notas/segredos.
**Agentes:** Impl; Teste com instrumentação de rede (proxy local que registra o que sai); Auditor de plano **com atenção à nuvem**.
Rotacionar a chave Gemini (ela apareceu no transcript da sessão de 2026-09-29) pertence aqui como tarefa explícita.

### F13 — Conversa natural, rápida e recuperável
**Objetivo:** falar normalmente, interromper e corrigir sem conhecer o pipeline; respostas com mais inteligência e naturalidade.
**Aceite:** H13.1 latência (200 turnos reais, fim da fala→primeiro áudio): local mediana ≤2 s/p95 ≤4 s; híbrido mediana ≤3 s/p95 ≤6 s, rede
registrada; H13.2 interrupção — áudio para ≤350 ms no p95, intenção do novo enunciado preservada ≥95% de 100; H13.3 continuidade —
40 diálogos de 6 rodadas, ≥90% das referências/correções/continuações resolvidas sem repetir o assunto; H13.4 ambiente real —
2 sessões de 30 min (fones/alto-falantes), ≤1 autointerrupção por eco/sessão; **H13.5 naturalidade e inteligência —
comparação cega (ordem aleatória) do usuário: ≥70% prefere a resposta nova à baseline atual**.
**Alavancas já identificadas (verificar com medição, não por intuição):** subir `max_output_tokens` (hoje 160, cortou a resposta
"céu azul") com constante **própria do Gemini**, desacoplada de `MAX_TURN_TOKENS`; revisar o prompt de tom (hoje otimizado para o Qwen3);
classificar com contexto; cortar histórico por rodada, não por mensagem; TTS: reavaliar Kokoro; voz em nuvem (ElevenLabs) **só com
plano + aprovação explícita (muda a fronteira de privacidade)**. TTFC de 7,57 s medido é o maior risco desta fase.
**Agentes:** Impl; Teste: harness de latência (`npm run bench:voice` estendido) e de avaliação cega; Auditor de código: Hermes/Kimi; Medidor: usuário.

### F14 — Ciclo completo de notas, lembretes e memórias
**Objetivo:** criar, consultar, localizar, editar o item **correto**, apagar, reagendar e **verificar** o resultado — as capacidades que
os subagentes da F15 vão usar.
**Aceite:** H14.1 120 tarefas nos 3 tipos, ≥95% corretas com no máximo 1 esclarecimento além da confirmação; H14.2 zero alteração no item
errado e zero horário silenciosamente substituído em 100 casos (itens parecidos, "amanhã às dez", recorrência, reagendamento);
H14.3 com Mac acordado e serviço ativo, ≥99/100 notificações até 10 s do horário; H14.4 30 cenários de reinício/suspensão/falha de
notificação sem lembrete sumindo em silêncio (atrasados/expirados/falhas consultáveis). Preview e execução usam o **mesmo alvo e dados**.
**Agentes:** Impl; Teste com relógio injetável; Auditor de plano de **mutação** (a classe de risco mais alta).

### F15 — Orquestrador autônomo e coordenador de subagentes (núcleo novo)
**Objetivo:** dado um pedido de voz de vários passos, o orquestrador **planeja, delega a subagentes, acompanha o estado, pede confirmação
onde muta, e fecha o ciclo falando o resultado verdadeiro** — com autonomia limitada por camadas de permissão.
**Modelo proposto (plano deve discutir e auditar):**
- **Camadas de autonomia:** (1) *leitura/consulta* — autônoma (conhecimento local, hora/data, consultar notas/lembretes/memórias);
  (2) *mutação reversível* — **sempre com confirmação por voz verificada** (`markPlayed()`); (3) *externo/irreversível/financeiro* — **proibido**.
- **Supervisor** (estende `sessionManager`/novo módulo) mantém um **grafo de tarefas** por turno: decompõe, despacha, coleta, reconcilia;
  **subagentes** = `IAgent`/`ITool` existentes encapsulados atrás de uma interface `ISubAgent` com contrato de entrada/saída tipado, orçamento
  (tempo, nº de chamadas ao Gemini, tokens) e **cancelamento cooperativo** (mesmo padrão de `activeTurn`/`abortController`).
- **Rastreabilidade:** todo passo registrado (quem decidiu o quê, o que saiu para a nuvem); "o que você fez?" é respondível pela voz.
- **Kill switch:** barge-in e comando de voz cancelam o plano inteiro; nenhuma mutação pendente sobrevive ao cancelamento.
- A decomposição pode usar o Gemini (fronteira já aprovada: só texto); **nunca** áudio, **nunca** `docs/research/` além do que a recuperação local já injeta e o usuário autorizou.
**Aceite:** H15.1 40 cenários multi-passo (ex.: "consulte minhas notas sobre X e crie um lembrete amanhã às dez com um resumo") — ≥90% concluídos corretamente;
H15.2 **zero mutação sem confirmação verificada** em 200 cenários adversariais (incluindo cancelamento no meio do plano, falha de subagente, resposta ambígua);
H15.3 100% dos passos rastreáveis e relatáveis por voz; H15.4 cancelamento por barge-in em ≤350 ms no p95 sem tarefa órfã; H15.5 orçamento: nenhum plano excede
o teto de chamadas/tempo definido no plano (teste de estresse).
**Agentes:** *planejamento mais longo da série* (≥2 rodadas de auditoria de plano com auditores diferentes; esta fase muda o modelo de segurança);
Impl em fatias (interface+supervisor, depois subagentes um a um); Teste: matriz adversarial + mutation testing do gate de confirmação; Auditor de código: Hermes + Kimi
**independentes** (cada um vê só o necessário). Consultar o Jev para limiares de autonomia (calibrar, não chutar 0,5).
**Decisão do usuário necessária:** quais capacidades entram na camada autônoma de leitura (ex.: busca na web? — hoje **não aprovada**, é saída de dado para a nuvem).

### F16 — Conhecimento pessoal que realmente ajuda
**Objetivo:** Teologia/Virtologia/memória respondem melhor *porque* conhecem as referências e preferências do Rodrigo.
**Aceite:** H16.1 80 perguntas com referências esperadas definidas antes: ≥90% corretas e compatíveis com o material, zero citação/posição pessoal inventada;
H16.2 40 perguntas sem resposta no corpus ou com posição indefinida: ≥95% reconhecem o limite sem atribuir opinião a Rodrigo; H16.3 60 cenários de memória
(antigos/recentes/conflitantes): ≥95% usam o fato certo, e correção/exclusão deixa de influenciar inclusive na sessão corrente; H16.4 40 comparações cegas:
≥70% preferem a versão personalizada. BM25 fica se passar; embeddings locais só se justificados por falha medida. Distinguir "a metodologia afirma"/"Rodrigo prefere"/"evidência independente".
**Cuidado:** avaliação com material pessoal só com o que o usuário autorizou processar na nuvem (a geração é Gemini).

### F17 — Qualificação 1.0 e congelamento
**Objetivo:** utilizável diariamente sem o desenvolvedor por perto; fim da expansão.
**Aceite:** H17.1 iniciar por atalho sem terminal, ≥19/20 inicializações prontas em ≤60 s; H17.2 30 dias e ≥300 tarefas reais: sucesso ≥95%, zero mutação não
autorizada, zero perda de dados, ≤1 intervenção técnica manual; H17.3 restaurar notas/lembretes/memórias em 3 exercícios de backup + falhas de rede/worker/TTS/permissão
com diagnóstico e recuperação verificáveis; H17.4 versões efetivas de modelo/dependências registradas (**o alias `gemini-flash-latest` não preserva aceite antigo após mudança de comportamento** → reavaliar o afetado);
H17.5 todos os H anteriores aprovados, docs e UI coerentes; novas funções vão para backlog pós-1.0. **Inclui configurar um remoto git/backup** (hoje não há).

---

## 8. Primeiros passos da próxima sessão (nesta ordem)

1. Reexecutar os comandos da seção 2 e **comparar**; relatar divergências.
2. Checar `/tmp/hermes-bargein-lean.log` (auditoria Hermes agendada do fix de barge-in; se vazio/ausente, **não repita às cegas** — o Kimi já aprovou com ressalvas, `docs/audits/bargein-fix-kimi-k3-2026-10-02.log`).
3. Reverificar a disponibilidade de `gemini-flash-latest` (uma chamada `curl` mínima) e registrar.
4. Tarefa de higiene: atualizar `CLAUDE.md` para as Fases 6–9 e 10a/barge-in (fatos por comando), commitar `.claude/launch.json` e o digest **ou** decidir ignorá-los.
5. Perguntar ao usuário: (a) reabrir as dívidas 5b/5c na F11? (b) ordem das fases — recomendo F11→F12→F13→F14→F15→F16→F17, mas F13 (naturalidade) responde a uma queixa viva e pode subir; (c) capacidades da camada autônoma de leitura na F15; (d) git remoto/backup.
6. Só então escrever `docs/phase-11-v1.md` seguindo o protocolo da seção 6. **Não construa à frente do plano aprovado da fase corrente.**

## 9. O que NÃO fazer

- Não trocar de provedor de geração com base na amostra de 4 perguntas; não adotar fala nativa (Realtime) sem decisão explícita — envia **áudio** à nuvem.
- Não adotar LangChain/CrewAI nem reescrever o orquestrador: o orquestrador próprio, com modelo de segurança auditado, é o ativo do projeto.
- Não declarar "terminado" com critério H sem número; não reduzir amostra para passar.
- Não commitar segredos nem `docs/research/`; não abrir `~/.hermes/.env` ou `auth.json`.
