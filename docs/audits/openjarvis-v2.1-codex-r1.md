# Auditoria adversarial do plano OpenJarvis v2.1: rodada 1 (Codex)

- **Alvo:** docs/plans/openjarvis-voz-desktop-v2.md no commit e1bc455, sha256 8df232a29ca011a1… (primeiros 16 hex)
- **CLI:** Codex 0.162.0-alpha.17.2 (binário embutido em /Applications/ChatGPT.app), modo `-s read-only`, esforço medium
- **Modelo (cabeçalho da execução):** gpt-5.6-sol. A resposta se rotula "[model: gpt-5-codex]"; vale o cabeçalho da CLI, e a divergência fica registrada.
- **Data:** 2026-10-13. **Tentativa 1 falhou** (processo morto no meio da leitura, saída vazia, código 0); esta é a tentativa 2.
- **Status dos achados:** saída de modelo é rascunho. Conferidos pelo Claude contra os arquivos: 1, 2, 3, 4, 5, 7, 9, 11, 14, 15, 16, 17, 19 (confirmados); os demais não conferidos um a um.
- A saída bruta do Codex termina com um bloco duplicado de conclusão (artefato do fluxo de saída); mantido sem edição.

---

[model: gpt-5-codex]

## Achados

### 1. A fronteira de nuvem descrita pelo plano não corresponde ao código atual

**ACHADO:** O plano apresenta Gemini como canal de texto e voz e afirma que todo canal de nuvem nasce desligado. O código possui também envio de imagem da tela e vários canais ligados por padrão.

**EVIDÊNCIA:**

- `docs/plans/openjarvis-voz-desktop-v2.md:28`: “Texto de resposta e voz usam o Gemini”.
- `docs/plans/openjarvis-voz-desktop-v2.md:32`: “todo canal de nuvem nasce desligado”.
- `src/backend/privacy.ts:113-122`: `RODRIGO_CLOUD`, intenção, histórico, memórias, TTS e visão têm padrão `true`; só conhecimento e busca web têm padrão `false`.
- `src/backend/voice/sessionManager.ts:707-710`: uma captura pode ser enviada a `describeScreen`.
- `scripts/worker/worker.py:1144-1171`: lê o JPEG e o envia ao Gemini com `Part.from_bytes(...)`.

**GRAVIDADE:** alta  
**CONFIANÇA:** 1,0  
**AÇÃO RECOMENDADA:** Reescrever a fronteira de dados incluindo geração, intenção, TTS, visão, busca web e subagentes. Definir explicitamente quais nascem ligados. Fazer T1 cobrir cada canal ou declarar, com justificativa, por que algum fica fora.

---

### 2. T5 está na ordem errada e contradiz sua própria dependência

**ACHADO:** T5 é colocada em paralelo com T1/T2 e declarada independente, mas sua própria implementação exige T2 e T3; T3 só vem depois.

**EVIDÊNCIA:**

- Plano `:48` e `:126`: T5 roda na primeira onda.
- Plano `:89`: “não depende de nenhuma outra trilha”.
- Na mesma linha: o `doctor` “declara suas capacidades na T3” e “passa pela política da T2, sem exceção”.
- Plano `:50`, `:79` e `:126`: T3 ocorre depois e depende de T2.

**GRAVIDADE:** alta  
**CONFIANÇA:** 1,0  
**AÇÃO RECOMENDADA:** Separar T5 em duas etapas: especificação/testes iniciais e implementação somente após T2+T3; ou remover sua dependência dessas trilhas mediante um mecanismo alternativo explicitamente testado.

---

### 3. T6 depende de T8, mas T8 está ordenada depois de T6

**ACHADO:** Um critério obrigatório de T6 requer a bateria e os limiares de T8. Entretanto, T8 ocorre depois, e seus limiares ainda dependem de baseline e decisão do usuário.

**EVIDÊNCIA:**

- Plano `:108`: equivalência de voz exige “a mesma bateria de VAD e barge-in do teste real com voz (T8) passando”.
- Plano `:118`: T8 não vira critério sem limiares numéricos aprovados.
- Plano `:126`: T6-C é etapa 5; T8 é etapa 6.
- Plano `:161`: os limiares não serão aprovados antes de uma medição real.

**GRAVIDADE:** alta  
**CONFIANÇA:** 1,0  
**AÇÃO RECOMENDADA:** Mover baseline, definição dos limiares e bateria T8 antes do aceite de T6. Se T6 for apenas um spike exploratório, retirar a equivalência de voz de seu aceite e criar um gate posterior separado.

---

### 4. O mecanismo de T2 não tem veículo de implementação definido

**ACHADO:** O plano exige `openat()` componente a componente e `fcntl(F_GETPATH)`, mas não define como isso será feito no runtime TypeScript/Node, que não expõe diretamente esse protocolo completo. Isso provavelmente requer helper nativo, processo auxiliar ou dependência nova.

**EVIDÊNCIA:**

- Plano `:75`: fixa `openat()`, `O_NOFOLLOW`, `fcntl(F_GETPATH)` e `fstat`.
- `src/backend/voice/voiceRuntime.ts:1-22`: runtime principal é TypeScript/Node, com worker Python especializado em voz.
- Plano `:32`: dependência externa nova exige plano, aval e auditoria.
- Plano `:75` e `:134`: reserva apenas 5–7 horas para T2.

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,96  
**AÇÃO RECOMENDADA:** Antes de estimar ou iniciar T2, escolher a fronteira executável: addon nativo, helper privilegiado mínimo, processo Python local ou mudança de arquitetura. Incluir modelo de falha, IPC, permissões, empacotamento e auditoria da dependência.

---

### 5. O teste TOCTOU proposto não corresponde claramente ao mecanismo seguro

**ACHADO:** O teste injeta um gancho “entre a checagem e a abertura”, justamente a separação que o mecanismo proposto diz eliminar. Não fica definido onde esse gancho existe na versão segura nem como a prova evita testar apenas uma implementação artificial.

**EVIDÊNCIA:**

- Plano `:75`: classificação e abertura ocorrem “nunca em duas etapas separadas”.
- Na mesma linha: o teste executa a troca “no ponto entre a checagem e a abertura”.
- O controle positivo usa “uma versão check-then-open”, mas não é dito se essa versão é produção mutada, fixture independente ou implementação duplicada.

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,94  
**AÇÃO RECOMENDADA:** Definir uma interface única de abertura. O teste deve instrumentar syscalls/descritores dessa implementação real, não uma segunda implementação de controle. A mutação deve alterar somente uma decisão concreta da produção e provar leitura zero, ausência de truncamento/escrita e bloqueio de componente pai.

---

### 6. T4 não define uma transação capaz de cumprir seu fail-closed

**ACHADO:** O plano exige que uma mutação seja recusada se o registro não puder ser gravado, mas também quer registrar resultado e tempos, conhecidos somente depois da execução. Sem protocolo de duas fases, uma falha após a mutação deixa estado alterado sem registro completo.

**EVIDÊNCIA:**

- Plano `:83-85`: o registro contém resultado e tempos; “sem registro, a mutação é recusada”.
- Código atual `sessionManager.ts:795-806`: depois do “SIM”, a ferramenta mutante é executada imediatamente.
- `sessionManager.ts:396-429`: o resultado e a duração só entram no trace depois de `agent.runTask(...)`.

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,99  
**AÇÃO RECOMENDADA:** Especificar protocolo durável de intenção prévia + execução + conclusão, com IDs idempotentes, recuperação após crash e semântica para registro final que falha. Não prometer recusa da mutação quando a falha só pode ser descoberta depois dela.

---

### 7. A prova de mutação de T4 conflita com a allow-list

**ACHADO:** Se a allow-list realmente exclui fala, argumentos e erros livres, remover apenas o guarda da T1 não deveria fazer um marcador do usuário aparecer no arquivo. O teste proposto ou não mata a mutação, ou precisa deixar conteúdo livre atravessar a allow-list.

**EVIDÊNCIA:**

- Plano `:85`: campos fechados; argumentos e erros livres “não são gravados”.
- Na mesma linha: “remover o guarda faz o marcador aparecer no arquivo”.
- `src/backend/agents/subAgent.ts:49-63`: o `ExecutionTrace` atual contém `prompt`, `result` e `query`, todos livres.

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,98  
**AÇÃO RECOMENDADA:** Criar um DTO persistível separado de `ExecutionTrace`. Testar independentemente: allow-list, normalização de nomes/códigos e guarda residual. Cada mutação deve matar exatamente uma dessas barreiras.

---

### 8. O teste anti-injection é probabilístico e não prova causalidade suficiente

**ACHADO:** “0 de N” respostas hostis e uma preferência benigna que altera a resposta não demonstram que ferramentas, roteamento e dados sensíveis permaneceram protegidos. A prova depende do comportamento variável do modelo.

**EVIDÊNCIA:**

- Plano `:63-66`: vinte payloads, cinco repetições, controle positivo e remoção da cláusula do prompt.
- A barreira atual é apenas textual em `sessionManager.ts:85-97`.
- O roteamento acontece antes de montar esse prompt: `sessionManager.ts:1011-1025`.
- Ferramentas e mutações são processadas antes da geração em `sessionManager.ts:747-806` e `:853-930`.

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,97  
**AÇÃO RECOMENDADA:** Separar testes de resposta, roteamento, chamada de ferramenta, mutação e exfiltração. Usar observadores determinísticos de chamadas/efeitos. A cláusula de prompt pode ser defesa adicional, não a barreira principal.

---

### 9. O teste de egress atual deixa a suíte verde sem provar egress global

**ACHADO:** O teste captura somente requisições que chegam ao Gemini falso. Uma nova conexão paralela, outro processo ou outro destino não observado não o faz falhar. Além disso, a suíte inteira pode ser pulada sem o venv.

**EVIDÊNCIA:**

- `f12Egress.test.ts:12`: `skip = !HAVE_VENV`.
- `f12Egress.test.ts:68`: o `describe` usa esse `skip`.
- `f12Egress.test.ts:90-95`: conta apenas `h.gemini.requests`.
- `f12Egress.test.ts:127-140`: invariantes percorrem somente `everyRequest`.
- O próprio plano `:67` reconhece que o teste “não vê tráfego real de outros processos”.

**GRAVIDADE:** alta  
**CONFIANÇA:** 1,0  
**AÇÃO RECOMENDADA:** Tornar o teste de barreira obrigatório no ambiente-alvo e falhar quando os pré-requisitos faltarem. Observar sockets/pacotes de todos os processos relevantes, não só tráfego encaminhado voluntariamente ao proxy.

---

### 10. A captura de CONNECT/DNS não prova “exatamente os hosts declarados”

**ACHADO:** Um proxy com log de CONNECT/DNS não cobre necessariamente QUIC/UDP, clientes que ignoram proxy, IP direto, DoH, conexões preexistentes ou subprocessos fora do escopo. A lista permitida sequer aparece definida.

**EVIDÊNCIA:**

- Plano `:67`: promete conjunto de hosts “exatamente o declarado” usando “proxy local registrando CONNECT/DNS”.
- Plano `:106`: inclui Chrome, atualizações e telemetria.
- Plano `:141`: generaliza isso como teste de rede real.
- Não há no plano uma allow-list concreta de hosts, portas, protocolos e processos.

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,96  
**AÇÃO RECOMENDADA:** Definir allow-list completa e usar observação/bloqueio no nível de rede do Mac, incluindo TCP e UDP. Iniciar processos em namespace/ambiente controlado, drenar conexões anteriores e demonstrar que uma mutação que abre conexão direta é detectada.

---

### 11. O teste do perfil do Chrome pode ser vácuo e seu controle positivo é perigoso

**ACHADO:** Plantar marcadores num “perfil real de teste” não demonstra isolamento do perfil principal se o Chrome testado sem flag usar outro perfil efetivo ou reutilizar um processo existente. O controle positivo sem `--user-data-dir` pode tocar o perfil real do usuário.

**EVIDÊNCIA:**

- Plano `:104`: planta cookie/extensão no “perfil real de teste”.
- Na mesma linha: o controle abre “sem a flag”.
- O teste principal apenas “lê os argumentos do processo”.
- A ausência de `--remote-debugging-port` é usada para sustentar que nenhum Chrome escuta porta de depuração, o que não é equivalência lógica.

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,95  
**AÇÃO RECOMENDADA:** Usar dois diretórios temporários explícitos, nunca o perfil real. Verificar o diretório efetivamente carregado pelo processo e as extensões/cookies por automação. Inspecionar portas abertas, não apenas flags. Testar reutilização de processo e Chrome já aberto.

---

### 12. “Sem navegação externa” não tem mecanismo de imposição

**ACHADO:** O plano especifica que navegar para outro host deve falhar, mas não define o bloqueio que causará a falha. `--app=http://...` e perfil vazio não constituem allow-list de navegação.

**EVIDÊNCIA:**

- Plano `:102`: “sem navegação externa”.
- Plano `:106`: testa link, `location` e redirecionamento, todos devendo falhar.
- Opção C em `:95`: apenas Chrome `--app=...` mais atalho.
- Plano `:100`: perfil sem extensões, eliminando uma possível camada de bloqueio por extensão.

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,98  
**AÇÃO RECOMENDADA:** Definir mecanismo obrigatório: firewall/proxy fail-closed, política gerenciada do Chrome ou wrapper nativo que intercepte navegação. Cobrir navegação principal, pop-ups, subrecursos, redirects, service workers e esquemas não HTTP.

---

### 13. A política de arquivos não cobre claramente todos os pontos de leitura

**ACHADO:** T2 é descrita principalmente como insumo do registro de executores e do `delegar`, mas o app lê arquivos diretamente em vários fluxos. Não há inventário de call sites nem garantia de que todas as aberturas passam pela política.

**EVIDÊNCIA:**

- Plano `:73`: enfatiza registro de executores e `delegar`.
- `voiceRuntime.ts:104`: carrega o corpus por `loadKnowledgeCorpus(rootDir)`.
- `voiceRuntime.ts:116-120`: aceita `RODRIGO_DATA_DIR` arbitrário.
- `sessionManager.ts:1061`: lê memórias diretamente do store.
- `worker.py:1149-1150`: abre a captura com `open(image_path, "rb")`.
- Plano `:211-220` reconhece caminhos externos e classes ausentes, mas isso permanece apenas rascunho.

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,98  
**AÇÃO RECOMENDADA:** Inventariar todos os leitores/escritores e definir quais ficam sob T2. Criar uma única API obrigatória ou declarar formalmente exceções. Testar bypass direto, caminhos fora do repositório e `RODRIGO_DATA_DIR`.

---

### 14. A lista efetiva de T2 continua divergente da revisão registrada

**ACHADO:** A trilha executável ainda apresenta a lista antiga, enquanto a própria seção 6.3 registra falsos positivos, omissões e um rascunho diferente não aprovado.

**EVIDÊNCIA:**

- Plano `:73`: lista antiga inclui `.env*`, `*.pem`, `credentials.*` e apenas `data/**`.
- Plano `:204-208`: identifica falsos positivos nesses padrões.
- Plano `:211-228`: identifica dados e credenciais fora da lista.
- Plano `:230`: apresenta lista revisada, “ainda não aprovada”.
- Plano `:232`: decisão 7 continua aberta.

**GRAVIDADE:** alta  
**CONFIANÇA:** 1,0  
**AÇÃO RECOMENDADA:** Retirar a lista antiga da especificação normativa. T2 não deve começar até existir uma única lista aprovada, versionada, com escopo dentro/fora do repositório, exceções e precedência.

---

### 15. T3 parte de capacidades meramente declarativas no código atual

**ACHADO:** `capabilities` existe na interface, mas o coordenador atual não consulta esse campo antes de executar `runTask`. O teste proposto não especifica um efeito observável para cada capacidade negada.

**EVIDÊNCIA:**

- `subAgent.ts:38-46`: `capabilities` é apenas uma propriedade.
- `sessionManager.ts:365-397`: busca o agente e chama `agent.runTask(...)` sem checar capacidades.
- Plano `:79`: promete recusa “antes de qualquer chamada” e mutação removendo um `deny`.

**GRAVIDADE:** média  
**CONFIANÇA:** 1,0  
**AÇÃO RECOMENDADA:** Definir um único ponto de enforcement anterior a `runTask`, com capacidades tipadas e contexto da operação. Para cada capacidade, tentar uma operação concreta e observar que o agente nem foi invocado.

---

### 16. “Reaproveitar ExecutionTrace” expõe conteúdo que T4 promete não persistir

**ACHADO:** O objeto atual contém a consulta, prompts e resultados dos subagentes. Persisti-lo ou serializá-lo diretamente viola a promessa de não gravar conteúdo do usuário.

**EVIDÊNCIA:**

- Plano `:83`: “Reaproveita o `ExecutionTrace`”.
- `subAgent.ts:49-63`: `TaskTraceItem.prompt`, `TaskTraceItem.result` e `ExecutionTrace.query`.
- `sessionManager.ts:367-374` e `:421-429`: esses textos são preenchidos no trace.

**GRAVIDADE:** alta  
**CONFIANÇA:** 1,0  
**AÇÃO RECOMENDADA:** Proibir serialização direta do trace atual. Criar um evento de auditoria fechado, sem herdar campos livres, e testar estruturalmente que propriedades extras são rejeitadas.

---

### 17. A origem do token está descrita incorretamente e parte da alegação não pôde ser verificada

**ACHADO:** A seção 0.1 diz que o token “nasce na própria página”; no código listado ele nasce no backend. Também não foi possível verificar que a página realmente o obtém nem que `/api/privacy` passa por Host/Origin, porque os arquivos de frontend e roteamento não estavam entre os autorizados.

**EVIDÊNCIA:**

- Plano `:24`: “o token da sessão de voz nasce na própria página”.
- `sessionManager.ts:519-545`: o backend cria `crypto.randomBytes(32)` e retorna o token.
- Plano `:106` usa redação diferente e mais restrita: a página “obtém” o token ao iniciar a sessão.

**GRAVIDADE:** média  
**CONFIANÇA:** 1,0 para a origem; 1,0 quanto à impossibilidade de verificar o frontend/rota no conjunto permitido  
**AÇÃO RECOMENDADA:** Corrigir “nasce” para “é gerado no backend e devolvido na criação da sessão”. Marcar as alegações de frontend e de `/api/privacy` como pendentes de verificação nos respectivos arquivos.

---

### 18. As correções declaradas na seção 0.1 não foram integralmente incorporadas

**ACHADO:** Algumas correções aparecem apenas nominalmente ou cobrem só parte das barreiras.

**EVIDÊNCIA:**

- Plano `:24` declara `doctor` sujeito a T2/T3, mas `:48`, `:89` e `:126` continuam tratando T5 como primeira onda independente.
- Plano `:24` declara “limiares na T8”; `:118` diz que ainda serão propostos, e `:182` afirma que os números consultados “não entram na seção 3.8”.
- Plano `:240` exige prova de mutação por barreira, mas para T6 cita apenas remover a flag do perfil; isso não mata bloqueio de navegação, egress, clipboard, persistência em disco ou porta de depuração.
- O teste T4 declarado em `:85` conflita com sua allow-list, conforme o achado 7.

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,99  
**AÇÃO RECOMENDADA:** Transformar a seção 0.1 em matriz rastreável: correção, seção normativa, teste que falha e mutação específica. Remover a afirmação “aceitos e aplicados” onde a incorporação ainda é incompleta.

---

### 19. A seção de decisões é internamente contraditória

**ACHADO:** O documento simultaneamente registra as decisões 7 e 8 como tomadas e diz que nenhuma das duas foi tomada.

**EVIDÊNCIA:**

- Plano `:159` e `:161`: “Decisão tomada (confirmada pelo Rodrigo...)”.
- Plano `:196`: “Nenhuma das duas decisões foi tomada”.
- Plano `:232`: decisão 7 continua aberta.

**GRAVIDADE:** média  
**CONFIANÇA:** 1,0  
**AÇÃO RECOMENDADA:** Distinguir três estados: decisão processual tomada (“não aprovar ainda”), aprovação substantiva pendente e insumo ainda não produzido. Não atribuir ao usuário um estado ambíguo.

---

### 20. Estimativas e critérios não são compatíveis com o trabalho descrito

**ACHADO:** As estimativas agrupam implementação multiplataforma, experimentos estocásticos, captura de rede, testes reais de Chrome e auditoria em poucas horas. Alguns critérios não definem método de medição.

**EVIDÊNCIA:**

- T1 `:69`: 8–11 h para guarda em dois runtimes, anti-injection e egress real.
- T2 `:75`: 5–7 h para mecanismo nativo, inode cache e suíte de corrida.
- T6 `:97-108`: 2 h para launcher, perfil, isolamento, navegação, egress, token, latência, foco e persistência.
- `:108`: “mesmos resultados” de T8 não define tolerância estatística.
- `:97`: uso em quatro de sete dias mede adoção, não segurança nem qualidade técnica.

**GRAVIDADE:** média  
**CONFIANÇA:** 0,97  
**AÇÃO RECOMENDADA:** Separar desenho, implementação, harness, execução no Mac e auditoria. Definir amostra, instrumento, tolerância e condição de falha para cada métrica. Tratar adoção como decisão de produto, não como aceite de segurança.

---

### 21. A afirmação absoluta de que o áudio do usuário nunca sai não está demonstrada pelos testes citados

**ACHADO:** O teste procura apenas algumas representações de áudio dentro dos corpos recebidos pelo Gemini falso. Ele não prova ausência de áudio em outros formatos, destinos ou processos.

**EVIDÊNCIA:**

- Plano `:28`: “o áudio do usuário nunca sai da máquina”.
- `f12Egress.test.ts:131-133`: detecta `UklGR`, `inlineData`, `inline_data` e `audio/`.
- `f12Egress.test.ts:142-146`: o controle positivo exercita apenas esse detector.
- Plano `:67` admite que o teste não vê tráfego real de outros processos.
- `privacy.ts:175`: `neverSends: ['audio']` é declaração de status, não medição.

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,99  
**AÇÃO RECOMENDADA:** Rebaixar a redação para uma propriedade a demonstrar ou implantar observação de rede global com mutações que tentem enviar WAV, PCM, formatos comprimidos e bytes genéricos por destinos alternativos.

## Três bloqueadores principais

1. **T4 não tem protocolo transacional capaz de impedir uma mutação quando o registro final falha.**
2. **T2 fixa primitivas nativas sem definir como serão implementadas no runtime e seu teste TOCTOU não corresponde claramente ao mecanismo real.**
3. **A fronteira de privacidade do plano está desatualizada: omite visão e outros canais ligados no código, enquanto T1 e os testes de egress não cobrem o sistema inteiro.**

Verifiquei 8 de 8 arquivos pedidos.
 rotas e ao cliente ou reclassificar essas afirmações como pendentes de verificação.

## Três bloqueios principais

1. **Ordem impossível:** T5 depende de T2/T3; T6 depende de T8; a conclusão de egress da T1 depende de T6.
2. **T4 não é transacional:** o fluxo atual executa a mutação antes de produzir o trace que deveria autorizá-la.
3. **Fronteira de privacidade incorreta:** os absolutos sobre canais desligados e `docs/research/` contradizem o código, e os testes de egress não cobrem visão, TTS, web/OpenClaw e Chrome.

Verifiquei 8 de 8 arquivos pedidos.
