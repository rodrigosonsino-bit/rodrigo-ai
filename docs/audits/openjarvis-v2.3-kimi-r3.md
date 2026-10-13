# Auditoria adversarial do plano OpenJarvis v2.3: rodada 3 (Kimi K3)

- **Alvo:** docs/plans/openjarvis-voz-desktop-v2.md no commit 3cfab6c, sha256 5ef4271091f3a06d… (primeiros 16 hex)
- **CLI:** `deepseek` (cliente de chat), `-m moonshotai/kimi-k3`, `--max-tokens 9000`, `--timeout 290`, via NVIDIA NIM (nuvem de terceiro). **Sem acesso a arquivos e sem execução**: só vê o que foi colado (o plano, em duas partes focadas, mais trechos do código com números de linha).
- **Por que Kimi:** o Hermes falhou (limite de uso sem login da Nous, resposta de 159 bytes, nada auditado). Kimi é de outra família que Codex e agy.
- **Histórico das tentativas (todas as falhas contam):** (1) material não montado por erro meu (TMPDIR diferente entre o shell com sandbox e sem sandbox); o Kimi respondeu corretamente "não há plano para auditar"; **descartada**. (2) plano inteiro de uma vez (~17 mil tokens): `ERRO: The read operation timed out` aos 290 s; **descartada**. (3) duas partes em paralelo, 15:19 a 15:24: **esta é a rodada válida**.
- **Limites:** o Kimi não executa nada e não vê o repositório. Achados que dependem de arquivos fora dos trechos colados ficam como NÃO VERIFICADO por ele.
- **Conferência do Claude** (contra os arquivos): confirmados A2, A4, B3 (=A8), B4, B6, B8; A6 confirmado em parte; **B1 rejeitado**.

---

## PARTE A (T1 a T4 e riscos)

# Auditoria adversarial — plano v2.3 (foco T1–T4 e seção 5)

**ACHADO 1 — O teste de egress como barreira repousa numa capacidade de captura de pacotes que não existe como descrita.**
EVIDÊNCIA: "a observação é **captura de pacotes** (tcpdump/pcap na interface, TCP **e UDP**, filtrada pelos processos do teste, incluindo QUIC e DNS)" (3.1). Filtro BPF de tcpdump/pcap não filtra por processo; atribuição por PID no macOS exigiria correlação externa (lsof/nettop, Endpoint Security), não especificada. O snippet `f12Egress.test.ts` colado só confirma o teste em loopback com skip por venv — nada do mecanismo de captura processual está demonstrado nem especificado, e ele é o coração da barreira.
GRAVIDADE: alta. CONFIANÇA: 0,85.
AÇÃO: especificar o mecanismo concreto de atribuição por processo no macOS (ou rebaixar o teste para "todo tráfego da máquina vs. lista de permitidos", com ruído declarado), e escrever a prova de mutação antes de declarar a barreira.

**ACHADO 2 — Contradição interna no critério de aceite: "suíte completa passa" vs. barreiras fora do `npm test`, com a não-execução só "declarada".**
EVIDÊNCIA: "a suíte inteira é **pulada** quando o venv do worker falta" (3.1) → correção: "`npm run test:barriers`, **fora do `npm test` comum**"; "o `npm test` comum **declara** quais barreiras não executou". Mas a seção 8 exige "suíte completa passa". Um CI/`npm test` verde nunca exercita pcap, TOCTOU real nem recusa com privilégio; "declarar" num log é silencioso na prática.
GRAVIDADE: alta. CONFIANÇA: 0,9.
AÇÃO: definir formalmente que "suíte completa" inclui `test:barriers` com evidência anexada ao PR; tornar a ausência de barreiras uma reprovação ou um bloqueio de merge, não uma linha de log.

**ACHADO 3 — O único canal real de injeção indireta (memórias → prompt de geração) fica coberto apenas por um teste probabilístico que o próprio plano declara "nunca o critério único" — logo não há barreira determinística alguma nesse canal.**
EVIDÊNCIA: "o bloco de memórias só é montado depois, para o prompt de geração (`:1067`)" — confirmado pelo código (`memoryBlock` e `knowledgeBlock` entram em `systemPrompt`, linhas 1067-1072); "*resposta falada:* o único teste probabilístico … É **defesa adicional**, nunca o critério único". Os testes estruturais de roteamento e ferramenta provam apenas a ausência de canal; o canal que existe (geração) fica sem barreira — nem cláusula de precedência verificável, nem guarda na saída falada contra obedecer instruções.
GRAVIDADE: alta. CONFIANÇA: 0,8.
AÇÃO: ou especificar uma mitigação determinística para o bloco de geração (delimitação/rotulação de dados não-confiáveis com teste estrutural, ou filtro de instruções na saída), ou declarar explicitamente na seção 5 que este vetor fica **aceito sem barreira**.

**ACHADO 4 — T2 cobre leitura e ignora escrita: o "inventariar todos os pontos que leem ou gravam arquivo" é traído pelo mecanismo especificado, que só devolve bytes lidos.**
EVIDÊNCIA: "Inventariar todos os pontos que leem **ou gravam** arquivo: `loadKnowledgeCorpus`… o `JsonStore`…" (3.2); porém "(a) helper no **worker Python** … o Python **abre, valida e lê o arquivo, e devolve os bytes ao Node**" — nenhuma palavra sobre como o `JsonStore` (que grava memórias/estado) escreveria com a mesma proteção (escrita via symlink para alvo sensível não segue `O_NOFOLLOW` de leitura; exige `O_CREAT|O_NOFOLLOW` componente a componente).
GRAVIDADE: alta. CONFIANÇA: 0,8.
AÇÃO: estender a especificação do `openSafe()` ao caminho de escrita (flags, truncamento, criação) ou declarar escrita fora de escopo e remover "ou gravam" do inventário.

**ACHADO 5 — Achado 4 da auditoria agy está "Corrigido (confirmado)", mas a confirmação não é demonstrável no material colado e a tabela admitidamente trata 13 dos 17 achados "por plausibilidade".**
EVIDÊNCIA: "**Conferi 4 contra os arquivos reais e todos se confirmaram** (4, 5, 7, 12); os demais foram tratados por plausibilidade" (0.3). Dos trechos colados, o achado 4 é confirmável (`classify(turn.turnId, turn.epoch, transcript)` na linha 1013), mas os achados 5 ("worker não usa function calling"), 7 (`F_GETPATH` existe no Python 3.12.13 do `.runtime`) e a afirmação "`capabilities` … (0 referências a `capabilities` nesse arquivo)" (3.3) **não** são verificáveis com os trechos fornecidos (o snippet 365-400 não prova ausência em todo o arquivo).
GRAVIDADE: média. CONFIANÇA: 0,9 (sobre o que dá para verificar daqui).
AÇÃO: rotular esses itens como NÃO VERIFICADO no plano até re-leitura; não contar "confirmado" como evidência para terceiros.

**ACHADO 6 — Lacuna de segurança não listada na seção 5: eco acústico / injeção via própria saída falada.**
EVIDÊNCIA: o assistente fala em voz alta (TTS) numa máquina que escuta continuamente pelo microfone; nada no plano (nem em 3.1, nem na seção 5, nem no G5) trata de cancelamento de eco ou de uma resposta falada que contenha instrução/“sim, confirma” sendo retranscrita como próxima entrada — o classificador de confirmação opera sobre `transcript`, e o plano assume transcrição = usuário.
GRAVIDADE: média-alta. CONFIANÇA: 0,7.
AÇÃO: adicionar risco transversal com mitigação (AEC, supressão de auto-transcrição durante TTS, exigência de janela de confirmação) e teste correspondente, ou declará-lo verificado no Mac antes de confiar no gate de confirmação falada.

**ACHADO 7 — Mitigação de clipboard é uma afirmação sem teste e sem trilha responsável.**
EVIDÊNCIA: seção 5: "**Clipboard** … Mitigação: Painel não lê nem escreve a área; scripts que copiam segredo limpam sozinhos". "Painel não lê nem escreve" é promessa sem prova de mutação escrita (a seção 8 lista mutações da T6-C e nenhuma cobre clipboard); "limpam sozinhos" depende de corrida com outros apps que leem a área de transferência — não é demonstrável e nenhum teste é nem proposto.
GRAVIDADE: média. CONFIANÇA: 0,75.
AÇÃO: ou definir teste (ex.: asserção de que nenhum código-fonte do painel importa API de clipboard) ou rebaixar a mitigação a risco aberto na seção 5.

**ACHADO 8 — Ordem/estimativas: T6-C (com "1 semana de uso") colocado depois da T4 sem justificativa de dependência, e as horas excluem explicitamente auditoria, harness e revisão.**
EVIDÊNCIA: "T6-C (spike, depois da T4, sem critério de voz)" (seção 4) — mas T6-C é um spike de painel/Chrome que não consome DTO da T4 nem o guarda da T1; risco 5 só o menciona para egress/clipboard/perfil, nenhuma dependência técnica citada. E: "A auditoria de cada trilha, o harness de execução no Mac e a revisão de código ficam **fora** destas contas" — os totais (T1 12–18 h etc.) subestimam sistematicamente o prazo real. Numeração da tabela também salta de 5/6 para 8 (T7) sem item 7.
GRAVIDADE: média. CONFIANÇA: 0,7.
AÇÃO: justificar a dependência T4→T6-C ou subir o spike (barato, 2 h) para antes e iniciar a semana de uso mais cedo; publicar estimativas com e sem os itens excluídos.

---

## Os 3 achados que mais bloqueiam a execução

1. **Achado 1** — sem mecanismo real de atribuição de tráfego por processo, a barreira central da T1 (egress) não é executável como especificada; tudo na T1 que depende dela (lista de permitidos aprovada, prova de mutação de conexão direta) fica bloqueado.
2. **Achado 2** — a contradição aceite vs. suíte separada permite que o pacote inteiro "passe" sem jamais rodar as barreiras que justificam o plano; inviabiliza o critério de aceite da seção 8 como escrito.
3. **Achado 4** — T2 bloqueia T3 e T4 (dependências declaradas), e seu mecanismo único (`openSafe()`) está especificado só para leitura: sem resolver o caminho de escrita do `JsonStore`, a T2 não pode ser implementada completa, travando T3, T4 e T5b em cascata.


---

## PARTE B (T5 a T9, ordem e decisões)

# AUDITORIA — PLANO v2.3 (foco T5–T9, seção 4, seção 6)

**ACHADO 1 — Teste de isolamento do perfil do Chrome é provavelmente vácuo por escopo de origem (porta)**
EVIDÊNCIA: 3.6 — "planta-se em B um cookie marcador **na origem `127.0.0.1:PORTA-DE-TESTE`**" enquanto o spike carrega "`http://127.0.0.1:PORT`". Cookies são escopados por origem (scheme+host+porta). Um cookie plantado em `127.0.0.1:PORTA-DE-TESTE` **nunca** apareceria em `document.cookie` na origem do spike mesmo que a janela usasse o perfil B — o teste (b) passa sem exercer o isolamento de perfil. O controle positivo (c) prova apenas que a página reporta cookies da própria origem, não que a barreira falha quando removida.
GRAVIDADE: alta. CONFIANÇA: 0,75.
AÇÃO: plantar o cookie marcador na **mesma origem da página do spike** (mesma porta), em B; provar a mutação (spike com diretório B → marcador aparece) antes de aceitar (b).

**ACHADO 2 — T6-C tem condição de existência não demonstrada e sem plano B executável**
EVIDÊNCIA: 3.6 — "se o mecanismo não puder ser **demonstrado** por testes, a T6-C não existe"; "para os esquemas não HTTP (`file:`, `data:`) ... é necessária **política gerenciada do Chrome** (`URLBlocklist`), possivelmente com administrador, e sem isso a T6-C não existe". A trilha está na ordem (seção 4, item 5) e alimenta o gate T6-voz, mas sua viabilidade depende de duas hipóteses de comportamento do Chrome não verificadas e de uma alternativa que "pode exigir administrador" — nada disso é testável pelo Claude sem Mac, e o executor no Mac é terceiro.
GRAVIDADE: alta. CONFIANÇA: 0,85.
AÇÃO: transformar "verificar hipótese do proxy/`file:`/`data:`" em pré-trilha T6-0 (spike do spike, 1–2 h no Mac) **antes** de comprometer harness de 6–10 h; declarar quem executa e o resultado corte/seguimento.

**ACHADO 3 — "Registro local de aberturas da T4" não existe no que está colado; critério de adoção e de latência dependem dele**
EVIDÊNCIA: 3.6 — "contado pelo registro local de aberturas da T4, sem conteúdo"; "atalho abre em até 300 ms (medido pelo registro local de aberturas)". Nenhum trecho da seção 2 mostra que a T4 ou qualquer componente registre aberturas de janela com timestamp; a T4 é descrita (0, item 6; 5) como guarda de gravação/mutação. Além disso, um registro de "abertura" não mede latência entre tecla e janela visível — não serve para o critério de 300 ms.
GRAVIDADE: alta. CONFIANÇA: 0,8.
AÇÃO: criar explicitamente o evento de telemetria local (quem escreve, onde, com timestamp de tecla e de exibição) como entrega da T6-C ou da T4; declarar NÃO VERIFICADO até lá; reformular a métrica de 300 ms.

**ACHADO 4 — Decisão 2 contradiz a própria trilha T6-C (omite o harness)**
EVIDÊNCIA: seção 6, decisão 2 — "aceitar o spike C com prazo (2 h + 1 semana)"; 3.6 — "C: 2 h de configuração mais 6–10 h de harness de testes, mais uma semana de uso"; seção 4 repete "2 h + 6–10 h de harness + 1 semana". A decisão pede aval sobre um custo 4–6× menor que o declarado na trilha que ela aprova.
GRAVIDADE: média. CONFIANÇA: 0,95.
AÇÃO: corrigir a decisão 2 para citar "2 h + 6–10 h + 1 semana" e explicitar que o aval cobre também a possibilidade de a trilha inexistir (achado 2).

**ACHADO 5 — Dependência da T6-C na infraestrutura de captura da T1 só declarada, não refletida na ordem nem nas estimativas**
EVIDÊNCIA: 3.6 — "**a captura de pacotes, cuja infraestrutura vem da T1, passa a incluir o processo do Chrome nesta trilha**". A seção 4 coloca T6-C "depois da T4", e T4 depende de T1 — ok por transitividade — mas nenhum custo de "estender a captura ao processo Chrome" entra nas estimativas (T1 12–18 h; T6-C harness 6–10 h), e o processo Chrome tem dezenas de conexões próprias (atualização, telemetria — o próprio plano admite) que precisam de lista de permitidos nova, não derivada da T1.
GRAVIDADE: média. CONFIANÇA: 0,8.
AÇÃO: listar a extensão da captura ao Chrome como subentrega da T6-C com estimativa própria e pré-requisito explícito "T1-captura concluída".

**ACHADO 6 — Absoluto proibido pela própria seção 8 reaparece na T7**
EVIDÊNCIA: 3.7 G5 — "o áudio fica **100% local**"; seção 8 — "nenhum texto afirma '100% local' quando há nuvem" e proíbe garantias absolutas sem teste. A T7 descreve canal novo enquanto o pipeline atual envia áudio/texto ao Gemini (`cloud: true` por padrão, `privacy.ts:113`); a frase afirma uma propriedade que nenhum teste do plano demonstra ("só monitorar ... sem código").
GRAVIDADE: média. CONFIANÇA: 0,85.
AÇÃO: rebaixar G5 para "propriedade a demonstrar quando houver implementação", conforme a própria regra da seção 8.

**ACHADO 7 — Afirmações da matriz 0.3 não verificáveis com o material colado**
EVIDÊNCIA: 0.3 — "Dúvida sobre `F_GETPATH` **resolvida**: existe no Python 3.12.13 do `.runtime`" (achado 7); decisão 9 — "O mecanismo `openat()`/`F_GETPATH` não existe no Node"; 3.5 — "usa a mesma validação de Host/Origin e token por sessão dos demais endpoints"; "o frontend e a validação de Host/Origin de `/api/privacy` continuam **sem verificação**". Os trechos colados confirmam apenas: `parsePrivacyConfig` existe (privacy.ts:111), `cloudVision: true` por padrão (privacy.ts:121), token gerado no backend (`crypto.randomBytes(32)`, sessionManager.ts:527), `classify` recebe só `transcript` (sessionManager.ts:1013), visão envia captura bruta (worker.py:1167-1171). Tudo o mais — `F_GETPATH`, flags do Chrome (`--proxy-bypass-list`, `--incognito` com `--app=`, comportamento de reutilização de processo), "registro de aberturas" — é NÃO VERIFICADO.
GRAVIDADE: média. CONFIANÇA: 0,9.
AÇÃO: rotular explicitamente esses itens como NÃO VERIFICADO no plano; exigir evidência no Mac antes de fechar a decisão 9 e o desenho dos testes da T6-C.

**ACHADO 8 — Aritmética da T8 declarada "a conferir" e tolerância estatística indefinida, mas tratada como concordante**
EVIDÊNCIA: 3.8 — "são necessárias da ordem de **110 repetições por categoria** ... (aritmética minha, a conferir) ... (concorda com a decisão 8)". Cálculo rápido de dois lados para p1=5% vs p2=15%, α=5%, poder 80% dá ~140/grupo, não 110; unilateral ~110. Ou seja, a suposição de teste (uni vs bilateral) não está declarada numa métrica que será critério de gate (T6-voz). "Tolerância estatística" é prometida ("fazem parte da entrega") mas não definida, e o gate T6-voz a referencia (3.6).
GRAVIDADE: baixa-média. CONFIANÇA: 0,7.
AÇÃO: fixar na T8-documento (antes da medição) a hipótese (uni/bilateral), α, poder e o cálculo de n por métrica; até lá, o gate T6-voz não tem critério.

---

## Os 3 achados que mais bloqueiam a execução

1. **Achado 2** — a T6-C pode "não existir" por hipóteses de navegador não demonstradas, sem pré-trilha de viabilidade; tudo a jusante (T6-voz, adoção) fica suspenso.
2. **Achado 1** — o principal teste de segurança do spike (isolamento de perfil) passa sem exercer a barreira, por escopo de origem de cookie; sem correção, o aceite de segurança da T6-C é inválido.
3. **Achado 3** — o critério de adoção e o critério de 300 ms dependem de um "registro de aberturas" que não está demonstrado existir; sem ele, a semana de uso não produz decisão nenhuma.
