# Auditoria adversarial do plano OpenJarvis v2.2: rodada 2 (agy)

- **Alvo:** docs/plans/openjarvis-voz-desktop-v2.md no commit 93963a2, sha256 abaaee85c2c61137… (primeiros 16 hex)
- **CLI:** `agy` 1.3.3, `--mode plan --effort high --dangerously-skip-permissions --print-timeout 60m`
- **Modelo:** a resposta se rotula `gemini-3.8-flash`; a CLI não imprimiu cabeçalho de modelo nesta execução, então o rótulo é auto-declarado e **não verificado** por outra fonte.
- **Data:** 2026-10-13. Auditor de família diferente da rodada 1 (Codex): rotação cumprida. Sem assinatura de falha; 17 achados; 9 de 9 arquivos lidos.
- **Status dos achados:** saída de modelo é rascunho. Conferidos pelo Claude contra os arquivos: 4, 5, 7 (inclusive a dúvida técnica sobre `F_GETPATH`, resolvida no Python do `.runtime`: 3.12.13 tem `F_GETPATH`, `dir_fd` e `O_NOFOLLOW`) e 12 (o `npm test` roda todos os testes de `dist`, incluindo `f12Egress`). Os demais foram avaliados por plausibilidade, ver a resposta ao Rodrigo.

---

[model: gemini-3.8-flash]

## Auditoria Adversarial: `docs/plans/openjarvis-voz-desktop-v2.md` (v2.2)

---

### ACHADO 1: Dependência cíclica impossível entre T1 (captura de egress) e T6-C (processo do Chrome)
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:75` (T1 colocada na ordem 1), `docs/plans/openjarvis-voz-desktop-v2.md:100` ("(f) o processo do Chrome do spike da T6-C entra nessa captura") e `docs/plans/openjarvis-voz-desktop-v2.md:165` (T6-C colocada na etapa 6).
- **GRAVIDADE:** Alta
- **CONFIANÇA:** 1.0
- **AÇÃO RECOMENDADA:** Desacoplar o teste de egress de T1 da existência do Chrome de T6-C. T1 deve cobrir estritamente os processos do runtime central (Node e worker Python). Criar uma extensão de teste de rede dedicada exclusivamente para a etapa do spike T6-C quando este for construído.

---

### ACHADO 2: Incoerência arquitetural em T5b declarando capacidades em T3
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:128` ("A T5b... declara suas capacidades na T3... e passa pela política da T2, sem exceção"), contrastado com `src/backend/agents/subAgent.ts:38-46` e `src/backend/voice/sessionManager.ts:365-397` (onde `capabilities` pertence à interface `ISubAgent` e governa unicamente delegações via `runTask()`).
- **GRAVIDADE:** Média
- **CONFIANÇA:** 1.0
- **AÇÃO RECOMENDADA:** Remover a afirmação de que `doctor` declara capacidades em T3. O `doctor` roda como CLI (`npm run doctor`) e rota HTTP (`GET /api/doctor`), não como subagente gerenciado pelo `SubAgentCoordinator`. A proteção de leitura em T5b deve invocar diretamente a API de acesso a arquivos de T2, sem fingir ser um subagente.

---

### ACHADO 3: Bloqueio artificial de prototipação de UI (T6-C) pela bateria estatística de áudio (T8)
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:136` ("depois da T4 e da T8"), `docs/plans/openjarvis-voz-desktop-v2.md:165` (T6-C como etapa 6 após T8 na etapa 5) e `docs/plans/openjarvis-voz-desktop-v2.md:157-158` (T8 exige ~440 turnos de voz real executados manualmente pelo usuário).
- **GRAVIDADE:** Média
- **CONFIANÇA:** 0.98
- **AÇÃO RECOMENDADA:** Se a equivalência de voz foi removida do aceite de T6-C e transferida para T6-voz (`:83-84`, `:147`), T6-C não tem dependência técnica de T8. Mover T6-C para rodar em paralelo após T4, mantendo T8 como pré-requisito unicamente do gate `T6-voz`.

---

### ACHADO 4: Teste anti-injection de roteamento é vácuo no código real
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:94` ("roteamento: o rótulo de classificação com uma memória hostil é o mesmo que sem ela") confrontado com `src/backend/voice/sessionManager.ts:1011-1013` (`label = await this.engine.classify(turn.turnId, turn.epoch, transcript)`).
- **GRAVIDADE:** Alta
- **CONFIANÇA:** 1.0
- **AÇÃO RECOMENDADA:** Reconhecer que o classificador de intenção/roteamento sequer recebe o bloco de memórias (que só é montado na linha 1061). O teste passaria sempre por ausência de canal, não por robustez a injeção. Reescrever o teste para injetar instruções adversariais no `transcript` (fala transcrita), que é o único texto consumido por `engine.classify()`.

---

### ACHADO 5: Teste anti-injection de ferramentas é vácuo no pipeline de geração
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:95` ("ferramenta: nenhuma chamada de ferramenta que o usuário não pediu... observada no registro de execução da ferramenta, não na fala do modelo"), confrontado com `src/backend/voice/sessionManager.ts:747-807` e `:853-930`.
- **GRAVIDADE:** Alta
- **CONFIANÇA:** 1.0
- **AÇÃO RECOMENDADA:** Reconhecer os limites do pipeline: o Gemini em `handle_generate` não possui tool-calling/function-calling ativo no runtime; ferramentas só são chamadas deterministicamente por intenção upstream ou confirmação de mutação. O teste mede uma impossibilidade arquitetural. Testar ferramentas contra injeção no `transcript` upstream, não no texto retornado pela memória.

---

### ACHADO 6: Teste anti-injection de exfiltração conflita com o envio legítimo de memórias
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:97` ("exfiltração: nenhum marcador sensível de uma nota aparece em corpo enviado ao Gemini falso por causa da injeção"), confrontado com `src/backend/privacy.ts:117` (`sendMemories: true` por padrão), `src/backend/voice/sessionManager.ts:1067-1070` (`buildMemoryBlock(memoryItems)` inserido no `systemPrompt`) e `src/backend/__tests__/f12Egress.test.ts:100` (`assert.equal(g.system.includes(MEM), sc.expect.memoryInSystem)`).
- **GRAVIDADE:** Alta
- **CONFIANÇA:** 1.0
- **AÇÃO RECOMENDADA:** Redefinir a propriedade de exfiltração: se `RODRIGO_SEND_MEMORIES=1`, os marcadores de memórias já são enviados por desenho no prompt do sistema. A exfiltração a ser testada deve ser o vazamento de notas *quando o canal está desligado* (`RODRIGO_SEND_MEMORIES=0`), ou exfiltração de dados que nunca deveriam ir ao prompt (como `.env` ou arquivos protegidos por T2).

---

### ACHADO 7: Inviabilidade de transporte de descritores de arquivo (FDs) no veículo proposto para T2
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:106` ("helper no worker Python que já existe, usando os.open com dir_fd e O_NOFOLLOW e fcntl.F_GETPATH... Interface única: toda abertura passa por uma função openSafe()"), confrontado com `src/backend/voice/voiceRuntime.ts:84-89` e `scripts/worker/worker.py` (comunicação exclusiva por pipes stdio com NDJSON).
- **GRAVIDADE:** Alta
- **CONFIANÇA:** 0.98
- **AÇÃO RECOMENDADA:** Descritores de arquivos abertos (`fds`) abertos pelo Python no kernel não podem ser transmitidos para o processo Node através de pipes de stdio NDJSON. Para usar o worker Python, seria necessário estabelecer um UNIX Domain Socket com passagem de descritores via `SCM_RIGHTS` ou fazer o Python atuar como proxy lendo e retornando os bytes em base64/buffer. Se for apenas validação prévia de caminho, reintroduz-se TOCTOU entre processos. Explicitar a arquitetura de IPC antes de orçar T2.
- *Nota técnica sobre ferramentas:* No macOS, `fcntl.F_GETPATH` (constante 50) não é exportado por padrão no módulo `fcntl` em várias compilações do CPython: **NÃO VERIFICADO** no Python embutido de `.runtime/.venv`; requer validação se precisa de `ctypes` ou constante numérica explícita.

---

### ACHADO 8: Teste de TOCTOU com controle positivo artificial em fixture isolada
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:110` ("(b) controle positivo: uma fixture separada, escrita só no teste e declarada como tal, que faz check-then-open tem de ler o conteúdo sensível sob a mesma troca").
- **GRAVIDADE:** Média
- **CONFIANÇA:** 0.95
- **AÇÃO RECOMENDADA:** Um controle positivo escrito em uma função artificial no arquivo de teste prova apenas que a função artificial é vulnerável, não que a suíte é capaz de pegar regressões na implementação real. O controle positivo deve ser uma mutação da própria função de produção `openSafe()` (ex.: chaveando uma flag interna para desativar a validação atômica), e não uma implementação duplicada.

---

### ACHADO 9: Ausência de mecanismo de inspeção no teste de perfil do Chrome sem porta de depuração
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:143` ("(b) isolamento: a janela do spike não enxerga os marcadores de B; (c) controle positivo: uma instância aberta de propósito com o diretório B enxerga os marcadores de B... (e) portas em escuta dos processos do Chrome são inspecionadas (lsof), não só a ausência de --remote-debugging-port").
- **GRAVIDADE:** Alta
- **CONFIANÇA:** 0.96
- **AÇÃO RECOMENDADA:** Se a instância do Chrome não possui `--remote-debugging-port`, CDP, WebDriver ou extensão de depuração, um script de teste externo automatizado não tem capacidade de inspecionar o DOM, cookies em memória ou contexto de execução da janela para validar se o cookie marcador de B é enxergado ou não. Especificar o mecanismo técnico exato pelo qual o teste lerá o estado interno da janela do Chrome, ou admitir que o teste só inspeciona arquivos no disco após o fechamento do navegador.

---

### ACHADO 10: `--proxy-server` não intercepta nem bloqueia esquemas `file:` e `data:`
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:145` ("lançar o Chrome do spike com um proxy inexistente... de modo que qualquer requisição fora de 127.0.0.1:PORT falhe... Testes: link, location, redirecionamento, pop-up, subrecurso, service worker e esquemas não HTTP (file:, data:) têm de falhar").
- **GRAVIDADE:** Alta
- **CONFIANÇA:** 1.0
- **AÇÃO RECOMENDADA:** `--proxy-server` atua apenas na camada de transporte de rede (HTTP/HTTPS/WS). Navegações para esquemas `file:///` ou `data:` são resolvidas localmente pelo próprio browser e ignoram proxies de rede. Apontar o proxy para uma porta fechada causará falha em HTTP externo (`ERR_PROXY_CONNECTION_FAILED`), mas não impede abertura de arquivos locais via `file:`. Para bloquear esquemas não HTTP, são necessárias políticas administrativas (`URLBlocklist`) ou bloqueio a nível de webview/extensão.

---

### ACHADO 11: Afirmação absoluta "conversa não vai a disco" contradiz o cache padrão do Chrome
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:147` ("conversa não vai a disco (varredura do perfil dedicado por um marcador falado)").
- **GRAVIDADE:** Média
- **CONFIANÇA:** 0.95
- **AÇÃO RECOMENDADA:** O Chrome, ao carregar a aplicação web via `--app=http://127.0.0.1:PORT`, grava cache HTTP em disco, histórico local, Service Workers e dados de renderização dentro do diretório `--user-data-dir`, a menos que seja executado em modo `--incognito` e com `--disable-gpu-shader-disk-cache` / cache desativado. Uma varredura de strings no diretório do perfil encontrará fragmentos de texto transmitidos pelo SSE. Adicionar `--incognito` explicitamente ou documentar que resíduos de cache em disco no diretório temporário isolado são esperados e descartados no encerramento da sessão.

---

### ACHADO 12: Teste de captura de pacotes com precondição que falha quebra execução unificada de testes
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:100` ("os testes novos têm precondição que falha, não que pula: sem o venv ou sem o Mac-alvo, o teste reprova com mensagem clara... captura de pacotes costuma exigir privilégio no Mac, então esse teste só roda com o Rodrigo... presente") e `docs/plans/openjarvis-voz-desktop-v2.md:283` ("Toda barreira de rede e de arquivo roda no Mac e falha, em vez de pular, quando o pré-requisito falta").
- **GRAVIDADE:** Alta
- **CONFIANÇA:** 0.97
- **AÇÃO RECOMENDADA:** Se a suíte automatizada rodar via `npm test` sem privilégios de `sudo`/root para escuta de pacotes de rede (`pcap`/`bpf`), o teste falhará de forma fatal, impedindo qualquer execução de CI local ou desenvolvimento comum. Esse teste deve ser isolado em script de auditoria pontual dedicado (ex: `npm run test:network-audit`) fora de `npm test`, ou ter um gatilho explícito de ambiente (`RUN_NETWORK_PCAP=1`).

---

### ACHADO 13: Protocolo T4 deixa mutações órfãs irreversíveis se a Fase 2 falhar
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:122` ("Se a fase 2 falhar, a mutação já ocorreu e não é desfeita: o sistema fala o aviso, e na próxima inicialização uma recuperação marca toda intenção sem conclusão como 'sem conclusão'").
- **GRAVIDADE:** Média
- **CONFIANÇA:** 0.95
- **AÇÃO RECOMENDADA:** Se a Fase 2 falha ou o processo cai logo após a mutação, o log marca "sem conclusão", mas a alteração persistente (lembrete criado em `data/lembretes.json` ou nota) foi consumada. Não há reconciliação transacional. O plano deve assumir explicitamente que T4 é um registro de auditoria com compensação tardia, e não uma transação ACID atômica com rollback.

---

### ACHADO 14: T2 não possui lista normativa aprovada de arquivos sensíveis
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:106` ("A lista antiga... foi retirada da especificação"), `docs/plans/openjarvis-voz-desktop-v2.md:201` ("aprovação substantiva da lista: pendente") e `docs/plans/openjarvis-voz-desktop-v2.md:263` ("Rascunho de lista revisada, não aprovado").
- **GRAVIDADE:** Alta
- **CONFIANÇA:** 1.0
- **AÇÃO RECOMENDADA:** A seção normativa de T2 atualmente depende de um insumo inexistente. A especificação técnica de T2 precisa conter ao menos uma lista inicial provisória formal ou declarar expressamente que a trilha está completamente bloqueada até a conclusão da Decisão 7 pelo usuário.

---

### ACHADO 15: Canal de visão permanece com envio irrestrito de imagem e sem sanitização
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:90` ("Imagem não é texto: o guarda da T1 não varre o conteúdo de uma captura de tela; o canal de visão fica coberto só pelo seu interruptor... Isso é uma limitação declarada, não uma cobertura"), `src/backend/privacy.ts:121` (`cloudVision: true` por padrão) e `scripts/worker/worker.py:1149-1171` (`client.models.generate_content` enviando bytes brutos do JPEG da tela ao Gemini).
- **GRAVIDADE:** Alta
- **CONFIANÇA:** 1.0
- **AÇÃO RECOMENDADA:** Reconhecer formalmente que o plano mantém uma lacuna de privacidade crítica aberta: capturas de tela contendo senhas, chaves de API visíveis no terminal ou dados pessoais continuam sendo transmitidas em bytes brutos ao Google se o canal de visão estiver ligado. A mitigação mínima exigível é desligar o canal de visão por padrão (`cloudVision: false`), exigindo opt-in deliberado do usuário assim como o canal de conhecimento (`RODRIGO_SEND_KNOWLEDGE`).

---

### ACHADO 16: Contradição residual entre tabela da Seção 0 e corpo normativo sobre T5
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:14` (Item 3 da tabela: "T5 passa a rodar junto de T1/T2 (é leitura de configuração, não toca fluxo de dados)") confrontado com `docs/plans/openjarvis-voz-desktop-v2.md:76`, `:80`, `:126-128` e `:165` (onde T5 foi dividida e T5b foi jogada para a etapa 3 após T2 e T3).
- **GRAVIDADE:** Baixa
- **CONFIANÇA:** 1.0
- **AÇÃO RECOMENDADA:** Atualizar a linha 14 da tabela da Seção 0 para refletir expressamente a divisão T5a / T5b implementada na v2.2.

---

### ACHADO 17: Afirmações absolutas não demonstradas remanescentes no texto normativo
- **EVIDÊNCIA:** `docs/plans/openjarvis-voz-desktop-v2.md:106` ("a abertura nunca segue symlink"), `docs/plans/openjarvis-voz-desktop-v2.md:122` ("A promessa fica: nunca existe mutação sem intenção registrada") e `docs/plans/openjarvis-voz-desktop-v2.md:124` ("Marcadores plantados... nunca aparecem no arquivo").
- **GRAVIDADE:** Média
- **CONFIANÇA:** 0.98
- **AÇÃO RECOMENDADA:** Em cumprimento à regra estipulada na Seção 8 (`:283`), rebaixar declarações categóricas com "nunca" para propriedades de projeto a demonstrar por teste, reconhecendo explicitamente as condições de falha não cobertas (ex: falhas catastróficas de I/O, panics antes da escrita do log).

---

## Os 3 achados que mais bloqueiam a execução

1. **Inviabilidade do veículo de implementação de T2 (ACHADO 7):** Propor que o worker Python existente realize a abertura segura de arquivos para o Node via `dir_fd` ignora que descritores de arquivos abertos (`fds`) não podem ser transmitidos através do protocolo atual de stdio NDJSON, exigindo uma reengenharia substancial de IPC.
2. **Dependência cíclica impossível e precondições fatais de teste em T1 (ACHADOS 1 e 12):** T1 exige que seu teste de captura de pacotes capture o Chrome de T6-C (que só existe cinco etapas depois) e estipula que testes sem ambiente/privilégio administrativo falhem em vez de pular, inviabilizando a execução normal de `npm test`.
3. **Mecanismo de teste do spike do Chrome é vácuo e ferramenta de proxy é inadequada (ACHADOS 9 e 10):** A suíte de T6-C não define como lerá cookies/extensões em uma janela sem porta de depuração, e utiliza uma porta de proxy morta que comprovadamente não intercepta nem bloqueia esquemas `file:` ou `data:`.

---

Verifiquei 9 de 9 arquivos pedidos.
