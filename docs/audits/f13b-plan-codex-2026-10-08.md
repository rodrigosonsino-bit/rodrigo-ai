# Auditoria do plano docs/phase-13b-v1.md — Codex (read-only, copia isolada so com o plano e 6 arquivos de codigo; sem docs/research)

Resultado: REFAZER. Decisao do usuario apos a auditoria (AskUserQuestion, 2026-10-08): "1,0 s (Recomendado)" — subir o limiar de silencio de 700 para 1000 ms em vez de juntar fragmentos no servidor. O plano v1 fica arquivado, nao implementado.


O plano precisa ser revisto antes da implementação. **Não encontrei um bypass já demonstrado de `markPlayed()` no código atual**: a execução exige `pendingMutation`, promovida após reprodução. Os riscos abaixo distinguem essa garantia das lacunas introduzidas pela junção.

Auditei os arquivos disponíveis e executei verificações isoladas do parser WAV e do classificador de confirmação. As medições externas de Whisper relatadas no documento não são verificáveis neste recorte.

1. **ACHADO — `falando` não significa que já houve áudio; o frontend pode destruir o candidato antes de `submitAudio`.**

   **EVIDÊNCIA:** O plano, linha 73, equipara `falando` a “já houve áudio”. Entretanto, [`sessionManager.ts:682–693`](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:682) emite esse estado **antes de chamar a geração**. O frontend dispara barge-in nesse estado, após 250 ms, e envia `/cancel` ([`voice.ts:187–205`](/private/tmp/claude-501/audit13b/src/frontend/voice.ts:187), [279–293](/private/tmp/claude-501/audit13b/src/frontend/voice.ts:279)). O cancelamento zera `activeTurn` ([`sessionManager.ts:955–958`](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:955)). Assim, uma continuação antes do primeiro áudio pode chegar ao servidor quando já não existe `P` juntável. Durante essa janela, o ramo `speaking` também retorna antes de acumular amostras na gravação.

   **GRAVIDADE:** ALTA. **CONFIANÇA:** Alta.

   **AÇÃO:** Corrigir a premissa e tratar explicitamente cancelamento antes do primeiro áudio. Testar pelo fluxo real do frontend; chamar apenas `submitAudio` nos testes não reproduz esse impedimento.

2. **ACHADO — `routing.handled` não identifica caminho de ferramenta, e sua emissão ocorre tarde demais para significar “entrou no caminho”.**

   **EVIDÊNCIA:** A condição (c), linha 51, usa essa equivalência. Porém, geração conversacional também emite `handled: true`, inclusive com `label: 'GERAL'` ([`sessionManager.ts:678–682`](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:678)). A detecção de mutação já pode estar suspensa em `await detectMutation` na [linha 513](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:504), enquanto o `routing` só aparece na linha 539. Para ferramenta comum, `execute()` antecede `routing` nas [linhas 583–596](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:583).

   **GRAVIDADE:** ALTA. **CONFIANÇA:** Alta.

   **AÇÃO:** Registrar no turno uma propriedade explícita de entrada em detecção/execução de ferramenta, antes dos respectivos `await`. Não inferir essa propriedade dos eventos de roteamento.

3. **ACHADO — A elegibilidade de `P` não impede que o texto unido origine uma mutação.**

   **EVIDÊNCIA:** Se `P` estiver em warmup, STT ou detecção ainda sem `routing`, as condições propostas podem permitir a junção. A transcrição resultante segue para `detectIntent`/`detectMutation`, `preview` e `armedMutation` ([`sessionManager.ts:487–557`](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:487)). Depois de `markPlayed`, um novo “sim” executará a ação com aquele conteúdo ([linhas 922–936](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:922), [440–450](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:440)).

   Isso **não viola, por si só, confirmação de uma única fala**: o “sim” posterior pode ser individual e legítimo. Mas contradiz uma leitura literal de H13b.3 como “nenhuma mutação executada a partir de texto colado”. O plano não distingue pedido unido de confirmação unida.

   **GRAVIDADE:** ALTA. **CONFIANÇA:** Alta quanto ao caminho; a política pretendida está ambígua.

   **AÇÃO:** Definir expressamente se pedidos de mutação podem nascer de áudio unido. Se puderem, exigir pergunta reproduzida e confirmação posterior individual; se não puderem, bloquear esse encaminhamento com base na proveniência da transcrição. Testar ambas as etapas separadamente.

4. **ACHADO — Falta especificar a operação atômica entre observar `P`, decidir a junção e substituí-lo.**

   **EVIDÊNCIA:** Hoje, cancelamento e instalação do novo turno ocorrem sem `await` em [`sessionManager.ts:330–363`](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:330). O turno antigo verifica sua identidade após warmup, STT e detecções ([368–378](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:368), [495–518](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:495)).

   Se a implementação consultar cabeçalhos com I/O assíncrono **entre a decisão e a substituição**, `P` poderá avançar, emitir uma pergunta, armar a mutação e receber `markPlayed`. Uma decisão antiga de “juntável” então permitiria entregar texto unido ao consumo de `pendingMutation` da linha 408. Duas submissões concorrentes também poderiam decidir sobre o mesmo `P`. Essa corrida depende da implementação futura; o plano não estabelece a ordem necessária para impedi-la.

   **GRAVIDADE:** ALTA. **CONFIANÇA:** Alta sobre a lacuna; condicional sobre sua materialização.

   **AÇÃO:** Preservar a substituição síncrona ou revalidar integralmente estado e identidade após qualquer espera. Acrescentar guardas após novos `await` de concatenação. Uniformizar a condição (b), que só menciona o início de `P`, com H13b.3, que também exige verificar o novo turno.

5. **ACHADO — Os contadores existentes não representam “áudio emitido”, e `emittedSentences` pode pertencer ao turno anterior.**

   **EVIDÊNCIA:** `expectedSentences` é preenchido antes da síntese ([`sessionManager.ts:707–708`](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:707)). `nextToEmit` avança inclusive para resultados nulos, falhas e timeouts ([857–864](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:857)). `emittedSentences` só muda de dono quando existe áudio pronto ([866–869](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:866)); `submitAudio` não o limpa.

   **GRAVIDADE:** MÉDIA. **CONFIANÇA:** Alta.

   **AÇÃO:** Definir um indicador por turno, atualizado no ponto de emissão, ou consultar `emittedSentences` exigindo `turnId === P.turnId`. Testar sessão com áudio antigo, síntese atual pendente, síntese falha e item pulado por timeout. Não usar `consumed` como autorização para juntar: reprodução concluída também impede junção.

6. **ACHADO — Remover imediatamente a mensagem de `P` pode apagar contexto válido se a substituição falhar.**

   **EVIDÊNCIA:** O plano manda remover a mensagem anterior na linha 65, mas não define recuperação. O novo STT pode retornar vazio e encerrar sem inserir mensagem ([`sessionManager.ts:376–393`](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:376)), ou lançar e cair no encerramento com erro ([738–747](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:738)). Além disso, inserir mensagens já provoca truncamento do histórico ([314–318](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:314)). Remover depois não recupera mensagens anteriormente expulsas.

   A afirmação da linha 96 — “hoje a primeira é descartada” — também é falsa para o histórico: a mensagem de usuário é inserida antes das detecções e permanece na preempção.

   **GRAVIDADE:** ALTA. **CONFIANÇA:** Alta.

   **AÇÃO:** Definir a substituição do histórico somente após obter uma transcrição unida válida, com comportamento explícito para falha, vazio e nova preempção. Manter a referência da mensagem e testar também histórico no limite e encadeamento de três fragmentos.

7. **ACHADO — “Uma transcrição” mistura chamadas de STT, histórico do servidor e apresentação ao usuário; o plano não garante as três coisas.**

   **EVIDÊNCIA:** Antes de a junção ocorrer, `P` pode já ter chamado `transcribe`, emitido `transcript` e inserido sua mensagem ([`sessionManager.ts:376–392`](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:376)). Logo, H13b.7 não pode exigir literalmente uma única chamada de STT para três fragmentos em todos os interleavings.

   O frontend encaminha cada transcrição para `onTranscript(event.text)`, sem passar o `turnId` ([`voice.ts:125–126`](/private/tmp/claude-501/audit13b/src/frontend/voice.ts:125)). Remover a mensagem no servidor não retrata o evento já apresentado. Com frontend inalterado, o plano tampouco demonstra a “uma fala transcrita” de H13b.9.

   **GRAVIDADE:** ALTA. **CONFIANÇA:** Alta.

   **AÇÃO:** Separar os critérios: última chamada transcreve o WAV completo; histórico final contém uma mensagem substituta; interface substitui ou mantém transcrições intermediárias conforme uma decisão explícita. Para transcrição visual única, prever identidade e substituição no cliente.

8. **ACHADO — “Nenhum áudio emitido” não garante que ainda exista um turno aproveitável; warmup, vazio e falhas precisam de critérios próprios.**

   **EVIDÊNCIA:** Warmup pode durar até 120 segundos ([`voiceProtocol.ts:124`](/private/tmp/claude-501/audit13b/src/shared/voiceProtocol.ts:124)) e ocorre antes de haver transcrição. Transcrição vazia zera `activeTurn` ([`sessionManager.ts:383–388`](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:383)); erro também ([738–747](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:738)). Falha de geração pode iniciar síntese de fallback; se as sínteses falharem, o turno termina sem áudio ([714–736](/private/tmp/claude-501/audit13b/src/backend/voice/sessionManager.ts:714)).

   Assim, fragmentos sem resposta podem ser juntados ou perdidos conforme o instante exato de conclusão, embora estejam dentro dos oito segundos.

   **GRAVIDADE:** MÉDIA. **CONFIANÇA:** Alta.

   **AÇÃO:** Declarar que turnos encerrados não serão recuperados, ou guardar um candidato separado com validade limitada. Cobrir preempção em cada `await`, especialmente warmup sem mensagem, STT vazio, geração falha e TTS sem emissão.

9. **ACHADO — Igualdade de taxa, canais e bits não prova que os arquivos sejam PCM compatível.**

   **EVIDÊNCIA:** [`wav.ts:32–40`](/private/tmp/claude-501/audit13b/src/backend/voice/wav.ts:32) não verifica o código de formato e aceita dados truncados usando `Math.min`. A rota usa esse parser como validação ([`routes.ts:161–168`](/private/tmp/claude-501/audit13b/src/backend/voice/routes.ts:161)).

   Verificação executada: cabeçalhos com formato PCM `1` e não PCM `6` produziram o mesmo `WavInfo`; um chunk declarando 32.000 bytes com apenas quatro disponíveis também foi aceito. Portanto, “cabeçalho legível” não sustenta o fail-closed proposto.

   **GRAVIDADE:** MÉDIA. **CONFIANÇA:** Alta, reproduzida.

   **AÇÃO:** Validar formato PCM suportado, limites dos chunks, alinhamento e integridade dos dados. Concatenar os chunks `data` efetivos, respeitando metadados e padding. H13b.6 deve conferir amostras e ordem, além de tamanho e duração.

10. **ACHADO — O exemplo de H13b.3 pode passar mesmo com a proteção de segurança removida.**

    **EVIDÊNCIA:** `classifyConfirmation` rejeita qualquer palavra desconhecida ([`confirmationClassifier.ts:199–205`](/private/tmp/claude-501/audit13b/src/backend/voice/confirmationClassifier.ts:199)). Executei os exemplos: `"sim e também"` retorna `AMBIGUO`, enquanto `"sim sim"` retorna `SIM`. Portanto, verificar apenas ausência de execução com o primeiro exemplo não prova que o classificador deixou de receber texto unido.

    H13b.8 exige somente que reverter a junção faça H13b.1 falhar; isso não exercita nenhuma barreira de segurança.

    **GRAVIDADE:** ALTA. **CONFIANÇA:** Alta, reproduzida.

    **AÇÃO:** Verificar ausência de junção e proveniência da entrada do classificador. Acrescentar texto unido que seria afirmativo, controle positivo com pergunta reproduzida e confirmação individual, `/played` obsoleto/repetido e conclusão tardia de turno cancelado. Remover cada guarda de segurança deve quebrar seu teste correspondente.

11. **ACHADO — A janela mede chegada do segmento completo, não a duração da pausa.**

    **EVIDÊNCIA:** O frontend só envia depois de terminar a gravação ([`voice.ts:232–263`](/private/tmp/claude-501/audit13b/src/frontend/voice.ts:232)); um segmento pode durar vinte segundos ([linha 12](/private/tmp/claude-501/audit13b/src/frontend/voice.ts:12)). O backend só chama `submitAudio` depois de receber e gravar o arquivo ([`routes.ts:151–174`](/private/tmp/claude-501/audit13b/src/backend/voice/routes.ts:151)).

    Uma continuação iniciada logo após o corte, mas falada por nove segundos, falhará na janela de oito segundos mesmo com pausa curta e nenhum áudio de resposta.

    **GRAVIDADE:** MÉDIA. **CONFIANÇA:** Alta.

    **AÇÃO:** Descrever o limite como intervalo entre submissões completas. Se a intenção é medir pausa, usar informação temporal da captura. Acrescentar teste de continuação longa e definir a origem temporal no encadeamento.

12. **ACHADO — A alternativa simples foi descartada sem um critério comparativo verificável.**

    **EVIDÊNCIA:** O corte nasce diretamente da comparação com `SILENCE_THRESHOLD_MS` ([`voice.ts:10`](/private/tmp/claude-501/audit13b/src/frontend/voice.ts:10), [232–233](/private/tmp/claude-501/audit13b/src/frontend/voice.ts:232)). Ajustar esse limiar conserva o áudio no mesmo WAV antes de qualquer STT, histórico, roteamento ou confirmação. O próprio plano reconhece essa alternativa, mas a descarta pelo custo de latência sem comparar sua eficácia no caso observado.

    **GRAVIDADE:** BAIXA. **CONFIANÇA:** Alta sobre o mecanismo; eficácia depende da medição real.

    **AÇÃO:** Comparar primeiro um aumento moderado do limiar com as pausas da pergunta original. Ele entrega uma única transcrição e resposta **para pausas abaixo do novo limite**, sem reescrever o orquestrador. Não cobre toda a janela proposta de oito segundos; esse alcance adicional deve justificar a complexidade e os riscos da junção retroativa.

**Veredito: REFAZER.**