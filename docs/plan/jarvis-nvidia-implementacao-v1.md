# Plano de implementação: o que aproveitar do OpenJarvis, o ícone de diálogo no desktop e a tecnologia de voz da NVIDIA (v1)

> Estado: **PROPOSTA. Sem código neste PR.** Nenhuma etapa começa sem aval do Rodrigo; as que tocam privacidade ou trazem dependência nova passam antes por auditoria de um modelo de outra família (`CLAUDE.md`).
> Autor: Claude Sonnet (reserva do orquestrador), 2026-10-13. Base: `origin/main` em `ccf03ca`.
> Documento escrito para ser lido também por quem não conhece o projeto (seção 1).

## 0. Resumo

O Rodrigo AI e o OpenJarvis fazem coisas parecidas (assistente pessoal de voz, local primeiro), mas o nosso é melhor no que mais importa para o uso real (conversa por voz com interrupção, ações só com confirmação ouvida, privacidade medida). O OpenJarvis é melhor em **segurança de dados na saída, diagnóstico, registro de decisões e permissões por capacidade**, e traz um **ícone na barra de menus + atalho global que abre um painel de conversa flutuante** no desktop.

Este plano propõe nove trilhas (T1–T9). As três primeiras são as de maior valor e menor risco. A voz da NVIDIA (PersonaPlex) entra como **avaliação com critérios de entrada** (T7), não como implementação: hoje ela não roda no Mac, não declara português e não tem gancho para confirmação nem ferramentas.

| Trilha | O que | Prioridade | Aval |
|---|---|---|---|
| T1 | Scanner de segredos e dados pessoais na saída para a nuvem | **1** | Sim + auditoria |
| T2 | Política de arquivos sensíveis, compartilhada com o registro de executores | **2** | Sim |
| T3 | Permissões por capacidade, com negar por padrão, para agentes | **3** | Sim (junto do PR #10) |
| T4 | Registro persistente das decisões (traces) sem conteúdo | 4 | Sim |
| T5 | `doctor`: diagnóstico de prontidão e de fronteira | 4 | Sim |
| T6 | Ícone na barra de menus, atalho global e painel flutuante de conversa | 5 | Sim (escolha de tecnologia) |
| T7 | Voz da NVIDIA (PersonaPlex): avaliação com critérios de entrada | 6 | Sim |
| T8 | Cenários de turno de conversa como lista de teste | 6 | Não |
| T9 | Itens menores (voz, Kokoro, auditoria com hash) | 7 | Caso a caso |

## 1. Contexto para quem lê pela primeira vez

- **Rodrigo AI:** assistente de voz pessoal em português do Brasil, em um Mac. Ouve pelo microfone, transcreve localmente, entende o pedido, responde por voz e pode criar lembretes, notas e memórias **só depois de uma pergunta falada e confirmada**. Texto de resposta e voz usam o Gemini (Google); o **áudio do usuário nunca sai** da máquina.
- **OpenJarvis:** projeto aberto (Apache-2.0, Stanford) de assistente local, com Ollama, faster-whisper e Kokoro. Apareceu num guia de @marcondes.ai ("Jarvis Local").
- **PersonaPlex:** modelo de conversa por voz da NVIDIA (código MIT, pesos com licença própria), que escuta e fala ao mesmo tempo.
- Regras do projeto que este plano respeita: nenhuma dependência externa nova sem plano, aval e auditoria; `docs/research/` nunca vai a terceiros; nenhum teste é afrouxado; todo canal de nuvem nasce desligado e declarado na tela.

## 2. O que foi verificado e o que não foi

**Verificado lendo o código (clones só de leitura, nada executado):**
- OpenJarvis `108d257` (2026-10-13): Python (+ Rust opcional), ~2.200 arquivos, ~650 de teste. Voz do terminal: Enter para falar, silêncio por volume, resposta inteira sintetizada depois de gerada, reprodução bloqueante, sem interrupção. Segurança: `boundary.py` (varre segredos e PII na saída; modos `redact`/`warn`/`block`), `file_policy.py`, `capabilities.py`, `taint.py`, `audit.py` (cadeia de hashes), `data_boundary_audit.py`. Traces em SQLite com analisador. App de desktop em Tauri (`frontend/src-tauri`), com painel nativo de macOS.
- PersonaPlex (último commit 2026-03-02): servidor só com `cuda` ou `cpu` (`mps` comentado no código), sem menção a português, treino em conversas sintéticas e inglês (Fisher), pesos `nvidia/personaplex-7b-v1` atrás de aceite de licença e token no Hugging Face. Sem chamada de ferramentas.
- Nosso código: o `redact()` do worker só atua em **logs**; nada varre o histórico, as memórias e o texto enviados ao Gemini (verificado por busca no código). O coordenador já tem `ExecutionTrace` (`src/backend/agents/subAgent.ts`), sem persistência nem agregação.

**Não verificado:** o cartão do modelo e a licença dos pesos da NVIDIA (Hugging Face bloqueado neste ambiente), o artigo do PersonaPlex, o desempenho real de qualquer um dos dois, e o comportamento do WKWebView com microfone no macOS do Rodrigo.

## 3. As trilhas

### T1. Scanner de saída (inspirado no `BoundaryGuard`)
**Por quê:** hoje o usuário pode ditar uma senha ou uma chave, e ela vai ao Gemini dentro do histórico, das memórias ou do texto de uma confirmação, sem nenhuma checagem.
**O que:** um módulo único (`src/backend/privacy/outboundGuard.ts`) aplicado onde o texto é montado para sair (histórico, bloco de memórias, texto da intenção) e, como defesa em profundidade, no worker antes da chamada ao Gemini (geração, intenção, voz). Modos `off | warn | redact | block` pela variável `RODRIGO_OUTBOUND_GUARD`, lida de forma estrita como as demais (valor inválido impede a inicialização).
**Padrões:** chaves e tokens de API, blocos de chave privada, `Bearer ...`, senha ditada ("minha senha é..."), CPF e CNPJ, cartão de crédito (com checagem de Luhn), e-mail e telefone. Lista pequena no início, para evitar falsos positivos na fala.
**Decisões de projeto:** padrão `redact`; `block` só por escolha explícita (derrubaria o turno); contadores por tipo em `GET /api/privacy` (**nunca o conteúdo**); a mensagem falada, quando algo é mascarado, é discreta e honesta.
**Testes (primeiro):** marcadores plantados no histórico, nas memórias e na fala não aparecem em nenhum corpo recebido pelo Gemini falso, nos modos `redact` e `block`; controle positivo com o guarda em `off`; texto sem segredo passa **idêntico**; prova de mutação (remover o guarda reprova o teste); os testes de egresso existentes continuam passando.
**Riscos:** mascarar muda o sentido da frase (aceito e declarado); falso positivo em número de telefone ditado como dado legítimo (lista conservadora e testes de matriz).
**Estimativa (minha, não medida):** 6–9 h. Auditoria por outra família antes de implementar.

### T2. Política de arquivos sensíveis (inspirada em `file_policy`)
**O que:** uma lista única de padrões (`.env*`, `*.pem`, `*.key`, `id_rsa`, `credentials.*` e os nossos: `docs/research/**`, `data/**`), com checagem que **segue a cadeia de symlinks** (um symlink não pode esconder um nome sensível). Vira um arquivo de dados no repositório, usado pelo registro de executores e pelo `delegar` para recusar tarefas sensíveis em executores de nuvem.
**Testes:** padrões casam; symlink para `.env` é bloqueado; arquivo comum passa; recusa registrada com a classe e sem conteúdo.
**Estimativa:** 3–4 h. Depende da lista de sensíveis aceita (handoff de 2026-10-12, §4).

### T3. Permissões por capacidade, com negar por padrão (inspirada em `capabilities`)
**O que:** cada agente do OpenClaw e cada executor do registro declara quais capacidades pode usar (ler arquivo, escrever arquivo, shell, navegador, rede, dados sensíveis). O padrão é negar. Casa com o agente dedicado e as restrições D2 do PR #10.
**Testes:** agente sem a capacidade é recusado antes de qualquer chamada; a declaração no registro e a política efetiva do OpenClaw são conferidas por um teste de coerência.
**Estimativa:** 4–6 h, junto do PR #10. Sem o aval do Rodrigo às decisões D1–D6 daquele plano, não começa.

### T4. Registro de decisões (inspirado em `traces`)
**O que:** persistir, **sem conteúdo**, o que o orquestrador decidiu por turno: rótulo de roteamento, ferramenta ou agente usado, executor, classe de dados, resultado da verificação e tempos. Reaproveita o `ExecutionTrace` que já existe. Gera um arquivo local em linhas (JSONL), com id de tarefa, para alimentar a revisão semanal e o piloto de roteamento por contrato.
**Testes:** nenhum campo de conteúdo é gravado (marcadores plantados na fala e na resposta não aparecem no arquivo); o arquivo roda sem quebrar com disco cheio ou arquivo corrompido (falha fechada: o turno segue, o registro avisa).
**Estimativa:** 4–5 h.

### T5. `doctor`: diagnóstico de prontidão e de fronteira (inspirado em `jarvis doctor` e `data_boundary_audit`)
**O que:** `npm run doctor` e `GET /api/doctor`, **só com configuração e existência de arquivo, nunca lendo notas, memórias ou conteúdo**. Verifica: ambiente de voz e manifesto (incluindo a entrada da visão, ver PR #12), modelos, portas, chave presente (sem mostrar o valor), orçamento de TTS, canais de nuvem ligados, e emite um aviso com gravidade quando uma combinação de risco aparece (por exemplo, memórias e histórico ligados com a chave no nível gratuito).
**Testes:** cada verificação tem um caso de falha e um de sucesso; o relatório não contém o valor da chave nem texto do usuário.
**Estimativa:** 5–7 h.

### T6. Ícone na barra de menus, atalho global e painel flutuante de conversa
**Como o OpenJarvis faz (verificado):** o app de desktop usa **Tauri** (Rust). No macOS, um painel nativo (`NSPanel` com `WKWebView` transparente) que **não rouba o foco**, flutua sobre todas as janelas e todos os espaços, abre com **Cmd+Shift+Space** e some com Esc; guarda o aplicativo que estava em primeiro plano para devolver o foco; a conversa é salva em `~/.openjarvis/overlay-conversation.json`. O painel do OpenJarvis é **só texto** (o arquivo de permissões do macOS não tem o direito de áudio). Pontos que **não** queremos copiar: a política de rede do app deixa o `connect-src` e `NSAllowsArbitraryLoadsInWebContent` abertos para qualquer host, e a conversa vai para um arquivo em texto puro na pasta do usuário.
**Opções para nós:**
| Opção | Esforço | Dependência nova | Observação |
|---|---|---|---|
| A. Tauri, como o OpenJarvis | Alto (milhares de linhas de Rust no original) | Rust, plugins do Tauri | Mais completo; risco de supply chain; é preciso fechar a política de rede |
| B. Electron | Médio | Electron (pesado) | Sem ganho sobre a D |
| C. Janela de aplicativo do Chrome (`--app=http://127.0.0.1:PORT`) + atalho do macOS (Atalhos/Raycast) | **Baixo** | Nenhuma | Valida a experiência; não flutua sobre todos os espaços; sem ícone próprio |
| D. App nativo pequeno em Swift (`NSStatusItem` + `NSPanel` + `WKWebView`) | Médio (centenas de linhas) | Nenhuma além do macOS | Resolve ícone, atalho e painel; pede assinatura do app e permissão de microfone |
**Recomendação:** começar pela **C** (sem risco, para o Rodrigo sentir se o atalho muda o uso), e decidir entre **D** e **A** depois, só se o painel flutuante sem roubar o foco fizer falta. **Qualquer que seja a opção**, o painel deve carregar a **mesma página real** `http://127.0.0.1:PORT` (não um esquema próprio), para que Host, Origin e token por sessão do servidor continuem valendo sem mudança. O painel **não abre porta**, não navega para fora do domínio local, não leva ferramentas de depuração na versão final e **não grava a conversa em disco** (o histórico é dado que "nunca sai" e não deve virar arquivo solto).
**Microfone no painel nativo (não verificado):** um `WKWebView` precisa da descrição de uso do microfone, da autorização do sistema e de tratar o pedido de permissão da página; sem assinatura estável, o macOS pode pedir permissão de novo a cada versão. Isso entra na medição da etapa 1 da opção D.
**Critérios de aceite:** atalho abre o painel em até 300 ms; Esc oculta; foco volta ao aplicativo anterior; voz funciona (microfone, VAD e barge-in iguais à página); nenhuma porta nova; a conversa não vai a disco; a suíte de Host/Origin/token passa sem alteração.
**Estimativa:** C 1–2 h (só configuração, no Mac); D 10–16 h (Swift, no Mac, o Grok executa); A não estimada (precisa de plano próprio).

### T7. Voz da NVIDIA (PersonaPlex): avaliação com critérios de entrada, não implementação
**O que é:** modelo de voz para voz, full-duplex (escuta e fala ao mesmo tempo, com interrupção e "backchannel" naturais), 7 bilhões de parâmetros, papel definido por um prompt de texto e voz por um áudio de referência.
**Por que não implementar agora:** (1) não declara português; (2) o servidor não roda em Apple Silicon (`mps` comentado); (3) não tem chamada de ferramentas nem ponto para a confirmação de mutação ouvida, que é a nossa garantia central; (4) os pesos têm licença própria, atrás de aceite no Hugging Face.
**Critérios de entrada (todos precisam passar para uma avaliação prática):**
- **G1** evidência de português do Brasil (cartão do modelo, artigo ou demo);
- **G2** caminho para o hardware do Rodrigo: porta MLX ou MPS, ou uma máquina com GPU **dele, na rede local**, para o áudio **nunca** sair de casa (alugar GPU de terceiros violaria a regra de que o áudio não sai);
- **G3** uma forma de manter as garantias: o modo da NVIDIA seria **conversa livre sem ferramentas** ("modo papo"), escolhido por comando de voz explícito, sem criar lembrete, nota nem memória; o modo comando continua com o nosso pipeline;
- **G4** licença dos pesos aceitável para o uso pessoal, lida pelo Rodrigo.
**Entrega, se G1–G4 passarem:** um relatório de avaliação (latência, qualidade em PT-BR, memória, comportamento de interrupção) em uma máquina que cumpra G2, como processo separado, atrás de um canal desligado por padrão e declarado no cartão. Sem código no app antes do relatório e do aval.
**Entrega hoje:** nada além de **monitorar** (verificação mensal de português, porta para Mac e novos modelos parecidos). Estimativa do relatório, se começar: 1–2 dias de uma máquina com GPU.

### T8. Cenários de turno de conversa como lista de teste
**O que:** usar as quatro categorias do FullDuplexBench citadas no README do PersonaPlex (interrupção do usuário, tratamento de pausa, backchannel, troca de turno suave) como lista de cenários para o teste real com voz, ligando-as às nossas medidas de barge-in e de pausa de fim de fala (hoje 1000 ms). Sem código.
**Estimativa:** 1–2 h de documento; a execução é do Rodrigo, com voz real.

### T9. Itens menores
- **Voz do fallback:** quando a voz do Gemini cai para a voz do sistema, avisar uma vez por sessão que a voz mudou (o OpenJarvis faz isso por backend). 2 h.
- **Kokoro persistente:** reaproveitar um único modelo entre frases (o nosso `KokoroVoiceProvider` sobe um processo por frase). Só se o Kokoro voltar a ser candidato. 4–6 h.
- **Registro de auditoria com cadeia de hashes** (detecta adulteração): opcional, para mutações. Avaliar depois da T4.
- **Assinatura de manifestos** (Ed25519): provavelmente exagero para nós; descartado por ora.

## 4. Ordem, dependências e quem executa

1. **T2** (pequena, destrava o registro de executores) e **T1** (maior ganho de privacidade), em paralelo. 2. **T3** junto do PR #10. 3. **T4** e **T5**. 4. **T6-C** a qualquer momento (é configuração no Mac); **T6-D/A** só depois de usar a C. 5. **T7** só como monitoramento até G1–G4. 6. **T8** antes do próximo teste com voz real.

| Quem | O quê |
|---|---|
| Claude (reserva) | Escreve os planos e os PRs de rascunho das T1–T5 e T9; sem acesso ao Mac |
| Grok, no Mac | Roda auditorias (agy e Codex), testes com o app e a configuração da T6-C |
| Rodrigo | Aprova cada etapa, decide a tecnologia da T6 e a licença da T7 |

**Estimativas (minhas, não medidas):** T1 6–9 h; T2 3–4 h; T3 4–6 h; T4 4–5 h; T5 5–7 h; T6-C 1–2 h (D: 10–16 h); T8 1–2 h; T9 até 12 h.

## 5. Riscos

| Risco | Mitigação |
|---|---|
| Scanner de saída mascara uma fala legítima | Lista conservadora, contadores visíveis em `/api/privacy`, `redact` por padrão |
| O painel desktop vira nova superfície de ataque | Mesma página loopback, sem porta nova, sem navegação externa, sem depuração na versão final |
| Dependência nova (Rust, Electron) | Recomendação é C e D, que não trazem nenhuma; A só com plano e auditoria próprios |
| Esperar demais pela voz da NVIDIA | Critérios G1–G4 e monitoramento mensal tornam a decisão objetiva |
| Copiar código do OpenJarvis sem aviso de licença | Apache-2.0 permite com aviso; preferir reescrever a partir da ideia e citar a origem |

## 6. Decisões do Rodrigo

1. Aprovar as trilhas T1–T3 e a ordem (T2 e T1 primeiro).
2. T6: começar pela opção C e decidir D ou A depois? Ou ir direto à D?
3. T7: aceitar a regra de que a voz da NVIDIA, se vier, seria um "modo papo" **sem ferramentas** e rodando em máquina dele, e não substitui o nosso pipeline?
4. Modo do scanner (T1): `redact` por padrão está bem?
5. Se a ativação por **palma** ou por palavra de despertar entra no escopo (o OpenJarvis não a traz; o guia manda escrever). É decisão de produto e de privacidade: hoje o microfone só escuta dentro de uma sessão aberta pelo usuário.

## 7. O que não entra

Instalar o OpenJarvis inteiro (dependência grande e instaladores `curl | sh`); extração automática de memória (contradiz a regra de memória só com confirmação falada); salvar a conversa do painel em arquivo de texto.

## 8. Critérios de aceite do pacote

Cada trilha tem testes que falham primeiro e prova de mutação nas barreiras novas; nenhum teste existente é afrouxado; `tsc` limpo; a suíte completa passa; toda mudança de privacidade atualiza o cartão, o README §7 e o teste de consistência no mesmo PR; nenhum texto afirma "100% local" quando há nuvem.
