**O Rodrigo AI tem uma base arquitetural sólida e uma proposta própria, mas ainda não atingiu a confiabilidade necessária para ser considerado um assistente pessoal terminado.** Seu melhor caminho competitivo é executar poucas tarefas com previsibilidade, conhecer bem Rodrigo e dar a ele controle verificável sobre dados e ações.

Li o digest inteiro. A análise abaixo distingue resultados documentados de conclusões pela leitura do código; não executei testes nem acessei `docs/research/`. Para os concorrentes, consultei documentação oficial disponível nesta consulta. Não há benchmark comparativo que permita afirmar superioridade geral de qualquer lado.

**A posição atual frente ao mercado**

| Referência | Onde estabelece uma barra relevante | Posição do Rodrigo AI |
|---|---|---|
| **Siri / Apple Intelligence** | Integração com sistema e aplicativos, contexto pessoal e processamento no dispositivo ou em Private Cloud Compute. [Apple](https://developer.apple.com/apple-intelligence/) | Atrás em integração cotidiana. Tem mais controle direto sobre metodologia e regras próprias, mas não pode presumir superioridade de privacidade apenas por usar loopback. |
| **Gemini Live** | Conversação, câmera/tela e ações em aplicativos como Calendar, Keep e Tasks, com disponibilidade variável. [Google](https://support.google.com/gemini/answer/15274899?co=GENIE.Platform%3DAndroid&hl=en) | Atrás em amplitude e continuidade entre aplicativos. A geração pelo Gemini aproxima a capacidade textual, mas não entrega automaticamente a experiência do Gemini Live. |
| **ChatGPT Voice** | Conversação com interrupções, acompanhamento de trabalho e contexto de tela nas configurações suportadas. [OpenAI Docs](https://learn.chatgpt.com/docs/features/voice) | Atrás na experiência conversacional e na amplitude das tarefas. Sua personalização explícita por domínio pode ser mais adequada ao dono, mas isso precisa de avaliação. |
| **OpenAI Realtime API** | Infraestrutura de fala diretamente para fala, ferramentas e tratamento de interrupção, incluindo remoção do conteúdo não reproduzido do histórico. [OpenAI Docs](https://developers.openai.com/api/docs/guides/realtime-conversations) | O princípio de `markPlayed()` está alinhado com uma preocupação de sistemas maduros. Não é exclusivo; a implementação completa ainda precisa ser validada. A API também não é um aplicativo pronto. |
| **Alexa+** | Assistência doméstica, lembretes personalizados e organização de calendários. [Amazon](https://www.aboutamazon.com/news/devices/new-alexa-plus-amazon-devices) | Atrás na disponibilidade cotidiana e na abrangência das ações. Lembretes que dependem do processo no Mac têm uma promessa operacional mais limitada. |
| **Pi** | Produto orientado a conversa pessoal, reflexão e interação por voz; sua apresentação atual também inclui lembretes. [Pi](https://hey.pi.ai/) | A personalidade especializada é promissora, mas prompts de identidade não comprovam escuta, tato ou continuidade conversacional. |
| **Home Assistant Assist** | Alternativa relevante para voz e automações locais, com pipeline inteiramente local disponível. [Home Assistant](https://www.home-assistant.io/voice_control/voice_remote_local_assistant) | Demonstra que processamento local não é exclusividade. Rodrigo AI pode se diferenciar pelo conhecimento pessoal e pela conversa especializada, em vez da automação doméstica. |

Disponibilidade por país, idioma, dispositivo e conta impede tratar todas essas capacidades como igualmente acessíveis em PT-BR no Mac.

**Onde já está à altura:** nos princípios de engenharia — ferramentas determinísticas, separação entre geração e execução, persistência com escrita atômica, cancelamento, extensão modular e preocupação com o que efetivamente foi reproduzido. São escolhas compatíveis com produtos maduros. A documentação franca das falhas também é uma vantagem de manutenção.

**Onde está atrás:** na taxa de conclusão de tarefas, recuperação de mal-entendidos, continuidade contextual, gestão dos itens salvos, operação cotidiana e naturalidade da conversa. São diferenças percebidas diretamente pelo usuário.

**Sua vantagem estrutural mais forte é a governabilidade pessoal:** Rodrigo pode inspecionar e modificar o corpus, a memória, a metodologia dos especialistas, os critérios de confirmação e o destino dos dados. Nos produtos comerciais citados, ele não controla integralmente esse conjunto. Isso permite otimizar o aplicativo para uma única pessoa e um conjunto estreito de necessidades.

Personalização, confirmação e processamento local, isoladamente, não são diferenciais exclusivos. **A combinação sob controle do dono é o diferencial.**

**Cinco pontos do digest mudam a avaliação**

1. **O produto atual é híbrido.** `sessionManager.ts` compõe identidade, memórias, referência recuperada e histórico; `worker.py` envia isso ao Gemini. Armazenamento e recuperação locais não significam conteúdo exclusivamente local. Até falas de ferramentas podem aparecer posteriormente no histórico enviado. A interface ainda contém afirmações incompatíveis com isso: ausência de chamadas externas, custos e operação sempre offline.

2. **As dívidas aceitas continuam impedindo uma declaração de conclusão.** H11 em 75%, H-mutação em 76,5% e H-confirmação em 61,1% significam que o usuário ainda precisa adaptar bastante sua fala. A mitigação do falso SIM foi útil, mas não recupera uma negação que desapareceu da transcrição. Zero falsos SIM na amostra posterior não estabelece impossibilidade de recorrência.

3. **A garantia de reprodução tem uma aparente brecha no cliente.** Em `voice.ts`, interromper chama `source.stop()`, mas `onended` também resolve a reprodução interrompida. Como `triggerBargeIn()` não invalida imediatamente `currentTurnId`, `playChunk()` pode enviar `/played` para uma frase incompleta. Além disso, o servidor anuncia `ouvindo` após a síntese, antes de necessariamente terminar o playback. São achados de leitura a reproduzir; podem afetar histórico, interrupção e autorização.

4. **O conhecimento pessoal ainda é uma capacidade estreita.** A recuperação consulta dois arquivos de perfil, seleciona um trecho de até 1.200 caracteres e não determina se existe resposta no corpus. O notebook de 101 fontes é origem do material, não evidência de consulta direta às 101 fontes. A memória injeta os dez fatos mais recentes, limitada também por caracteres; não seleciona necessariamente os mais relevantes. Sem o corpus omitido, não posso avaliar sua qualidade.

5. **Há capacidades começadas sem o ciclo completo de uso.** Notas podem ser salvas, mas não há ferramenta para consultá-las. Edição e exclusão recaem sobre o item mais recente. Não há reagendamento. “Amanhã às dez” pode cair no reconhecimento genérico de “amanhã”, às nove, deixando a hora solicitada no texto residual. O sucesso do `osascript` também não comprova que a notificação foi vista.

O benchmark de aproximadamente 3,2 segundos é um resultado histórico positivo. Ele não certifica a latência atual após novos detectores e geração em nuvem. Tampouco usaria o antigo relato de repetição como justificativa para trocar modelos: o próprio projeto corrigiu a interpretação daquele problema.

**O “fim fixo” que eu definiria**

> Rodrigo AI 1.0 é um assistente pessoal de voz em PT-BR, para Rodrigo no MacBook validado, que conversa sobre Geral, Teologia e Virtologia; administra notas, lembretes e memórias; permite consultar e corrigir o que guardou; executa somente ações autorizadas; e torna verificável o que permanece local e o que sai para geração em nuvem.

O escopo termina aí. Aplicativo móvel, acesso remoto, casa inteligente, compras, mensagens, câmera, palavra de ativação e clonagem de voz ficam fora da conclusão da 1.0.

Loopback-only, MLX local, `ExtensionRegistry` e plano com auditoria adversarial permanecem obrigatórios. A exceção já aprovada para geração pelo Gemini permanece válida. Cada fase abaixo exige plano auditado antes da implementação e evidência posterior de aceite; este roadmap é uma proposta de produto, não substitui esse processo.

**As bifurcações de produto devem ficar explícitas**

| Decisão | Benefício | Compromisso assumido |
|---|---|---|
| **Manter o híbrido atual como padrão da 1.0** | Aproveita geração em nuvem e preserva áudio, classificação e execução locais. | Texto pessoal autorizado sai do Mac; há dependência de internet, provedor e custos. |
| **Exigir conversação inteiramente local** | Nenhum conteúdo da conversa precisa sair. | Exige reintroduzir e avaliar geração local; qualidade, velocidade e memória disponível passam a limitar a experiência. Não é necessário para concluir a versão híbrida já aprovada. |
| **Adotar fala nativa em nuvem futuramente** | Pode melhorar prosódia e troca de turnos. | Envia áudio e altera a fronteira atual de privacidade. Exige nova decisão explícita, plano e auditoria. |

Clonagem de voz não exige necessariamente nuvem; pode existir uma alternativa local. Porém, viabilidade e qualidade em PT-BR nesse hardware precisariam ser medidas. Eu a deixaria fora da 1.0. Uma voz já escolhida pelo usuário não precisa ser substituída para o produto ficar completo.

**Como medir o roadmap**

Os números seguintes são **metas propostas**, não resultados existentes nem estatísticas dos concorrentes.

As avaliações de voz devem usar Rodrigo falando naturalmente, em dias diferentes, com modelos reais e navegador real. Fones e alto-falantes devem ter resultados separados. Áudio sintetizado continua útil para regressão, mas não serve sozinho para certificar experiência humana.

Separe conjunto de desenvolvimento e conjunto reservado de avaliação. Depois que uma falha orientar ajustes, aquele caso vira regressão; não continua sendo evidência inédita. Publique numeradores e denominadores, além das porcentagens.

**Fase 1 — Tornar autorização e resultado confiáveis**

Esta é a maior prioridade: o aplicativo precisa distinguir corretamente pedido, confirmação, execução e sucesso.

O trabalho inclui verificar o caminho completo de playback, tratar confirmação incerta como pedido de esclarecimento e impedir que falhas de roteamento produzam declarações inventadas de ação concluída. Um botão de confirmação pode ser alternativa, preservando a meta de uso por voz.

| Critério | Aceite |
|---|---|
| **H1.1 — Intenção** | Em 200 falas inéditas, balanceadas entre pedidos suportados e distratores, precisão e recall ≥95% separadamente para hora/data e mutações. |
| **H1.2 — Confirmação** | Aceitar ≥95% de 100 confirmações afirmativas naturais; executar **zero ações** em 300 casos de negação, ambiguidade, ruído ou ausência de confirmação. |
| **H1.3 — Reprodução e cancelamento** | Em 100 cenários com interrupção, atraso e repetição de eventos, nenhuma pergunta incompleta habilita execução; nenhuma frase interrompida é registrada como integralmente reproduzida. |
| **H1.4 — Resultado verdadeiro** | Em 100 cenários de falha e pedido não suportado, zero alegações falsas de “salvei”, “apaguei”, “agendei” ou hora/data obtida sem ferramenta. |

Zero ocorrências nessas amostras é uma condição de lançamento, não prova de risco zero. Ações financeiras, mensagens externas e operações irreversíveis continuam fora do escopo.

**Fase 2 — Fazer a privacidade corresponder à promessa**

Esta fase resolve uma contradição atual do produto. A interface deve informar claramente que áudio fica local e determinados textos podem ir ao Gemini, com controle sobre quais memórias e referências podem sair.

Os termos atuais do Gemini distinguem serviços pagos e não pagos. Nos pagos, o Google declara não usar prompts e respostas para melhorar produtos, mas prevê retenção limitada para determinadas finalidades. O digest não permite identificar o enquadramento da conta de Rodrigo. [Termos oficiais](https://ai.google.dev/gemini-api/terms)

| Critério | Aceite |
|---|---|
| **H2.1 — Transparência** | Nenhuma tela ou instrução de operação afirma ausência de nuvem/custo quando a geração externa está habilitada; o modo efetivo aparece antes da conversa. |
| **H2.2 — Controle de saída** | Em 100 turnos instrumentados com dados sintéticos identificáveis, zero áudio bruto e zero conteúdo marcado como exclusivamente local aparecem em requisições externas. |
| **H2.3 — Funcionamento sem internet** | Em 50 tarefas locais suportadas, ferramentas continuam disponíveis sem Gemini; geração indisponível é comunicada claramente, sem envio por outro provedor. |
| **H2.4 — Retenção local** | Encerrar sessão remove seus áudios temporários; após encerramento abrupto, a próxima inicialização limpa os resíduos. Logs de operação não contêm conversa, notas ou segredos na matriz de verificação. |

Bloquear um dado precisa impedir também sua saída por histórico ou resumos derivados. Apenas removê-lo do bloco de memória não basta.

**Fase 3 — Sustentar uma conversa confortável e recuperável**

Aqui entram troca de turnos, contexto e recuperação de erros. O objetivo é permitir falar normalmente, interromper e corrigir sem conhecer o pipeline.

Hoje a classificação usa a fala isolada, prejudicando continuações como “e como isso se aplica?”. O histórico também é cortado por quantidade de mensagens, contando frases do assistente separadamente; isso não equivale a oito rodadas completas de conversa.

| Critério | Aceite |
|---|---|
| **H3.1 — Latência percebida** | Em 200 turnos reais, do fim acústico da fala ao primeiro áudio útil: tarefas locais com mediana ≤2 s e p95 ≤4 s; geração híbrida com mediana ≤3 s e p95 ≤6 s, sob condição de rede registrada. |
| **H3.2 — Interrupção** | Parar áudio em ≤350 ms no p95 após início da fala de interrupção; preservar a intenção do novo enunciado em ≥95% de 100 tentativas. |
| **H3.3 — Continuidade** | Em 40 diálogos de seis rodadas, ≥90% das referências, correções e continuações são resolvidas sem Rodrigo repetir o assunto inteiro. |
| **H3.4 — Ambiente real** | Em duas sessões de 30 minutos, uma com fones e outra com alto-falantes, no máximo uma autointerrupção por eco por sessão; ≥95% dos enunciados capturados sem corte que altere o sentido. |

Não exigiria paridade de expressividade com voz nativa. Exigiria inteligibilidade, ritmo aceitável e ausência de atrito recorrente. A voz Felipe pode continuar sendo a escolha final.

**Fase 4 — Completar notas, lembretes e memórias**

Antes de adicionar ferramentas, conclua as existentes: criar, consultar, localizar, editar o item correto, apagar e verificar resultado. Para lembretes, incluir reagendamento e identificação clara da próxima ocorrência.

O alvo e os dados da operação precisam ser os mesmos na prévia e na execução. “Apagar o mais recente” deve ser uma opção explícita, não a única interpretação disponível.

| Critério | Aceite |
|---|---|
| **H4.1 — Ciclo completo** | Em 120 tarefas distribuídas entre os três tipos de item, ≥95% concluídas corretamente com no máximo uma rodada adicional de esclarecimento, além da confirmação obrigatória. |
| **H4.2 — Identidade e tempo** | Zero alterações no item errado; zero horários silenciosamente substituídos em 100 casos, incluindo itens semelhantes, “amanhã às dez”, recorrência e reagendamento. |
| **H4.3 — Lembretes** | Com Mac acordado e serviço ativo, ≥99 de 100 notificações aparecem até dez segundos após o horário, em ambiente de teste com notificações permitidas. |
| **H4.4 — Recuperação** | Em 30 cenários de reinício, suspensão e falha de notificação, nenhum lembrete desaparece silenciosamente; atrasados, expirados e falhas ficam consultáveis. |

O Mac desligado não pode avisar. A promessa deve especificar serviço ativo e comportamento ao retornar. Isso é uma limitação legítima de escopo, desde que o aplicativo a exponha.

**Fase 5 — Demonstrar conhecimento pessoal útil**

A pergunta desta fase é: **o sistema ajuda Rodrigo melhor porque conhece suas referências e preferências?**

Priorize relevância da memória, continuidade entre sessões, fontes inspecionáveis e tratamento de posições em aberto. BM25 pode permanecer se atingir a barra; embeddings locais ou recuperação híbrida só se justificam por falhas medidas.

Também deve haver distinção entre “a metodologia de Virtologia afirma”, “Rodrigo prefere” e “há evidência independente”. Fidelidade ao dono inclui respeitar suas posições sem transformar toda formulação do perfil em fato universal.

| Critério | Aceite |
|---|---|
| **H5.1 — Respostas fundamentadas** | Em 80 perguntas de Teologia/Virtologia com referências esperadas definidas previamente, ≥90% corretas e compatíveis com o material; zero citações ou posições pessoais inventadas. |
| **H5.2 — Limites do conhecimento** | Em 40 perguntas sem resposta no corpus ou com posição pessoal indefinida, reconhecer corretamente o limite em ≥95%, sem atribuir opinião inexistente a Rodrigo. |
| **H5.3 — Memória relevante** | Em 60 cenários com fatos antigos, recentes e conflitantes, usar o fato correto em ≥95%; correção ou exclusão explícita deixa de influenciar respostas nos casos testados, inclusive na sessão corrente. |
| **H5.4 — Valor da personalização** | Em 40 comparações de conteúdo com ordem aleatória e identificação ocultada, Rodrigo prefere a versão personalizada em ≥70% dos casos, contra a mesma geração sem personalização. Usar apenas material autorizado para esse processamento. |

As fontes podem aparecer na interface sem serem recitadas. Isso preserva a conversa curta e permite conferir o fundamento quando necessário.

**Fase 6 — Qualificar a versão final e encerrar a expansão**

Esta fase transforma o sistema em algo utilizável diariamente sem manutenção constante do desenvolvedor. Inclui início simples, diagnóstico de prontidão real, recuperação, backup e documentação coerente.

`/api/health` responder não comprova que microfone, modelos, voz e geração estão disponíveis. Da mesma forma, registrar uma extensão não comprova que suas dependências funcionam.

| Critério | Aceite |
|---|---|
| **H6.1 — Operação cotidiana** | Após configuração inicial, iniciar pelo atalho definido sem terminal; em 20 inicializações, ficar pronto em até 60 s em ≥19, com estado de aquecimento correto. |
| **H6.2 — Uso sustentado** | Durante 30 dias e pelo menos 300 tarefas reais, sucesso ≥95%, zero mutações não autorizadas, zero perda de dados e no máximo uma intervenção técnica manual. |
| **H6.3 — Recuperação e backup** | Restaurar notas, lembretes e memórias corretamente em três exercícios; falhas de rede, worker, TTS e permissões produzem diagnóstico e recuperação verificáveis. |
| **H6.4 — Versão reproduzível** | Registrar versões efetivas de modelos, dependências e configurações; mudanças materiais repetem a avaliação afetada. O alias `gemini-flash-latest` não pode preservar automaticamente um aceite antigo após mudança de comportamento. |
| **H6.5 — Encerramento** | Todos os critérios anteriores aprovados, documentação e interface coerentes, sem dívida aberta de autorização, perda de dados ou divulgação indevida. Novas funcionalidades vão para um backlog posterior à 1.0. |

**A conclusão da 1.0 ocorre quando essas seis fases passam, mesmo que um concorrente lance novas funções.** Depois disso, o trabalho é manutenção e evolução deliberada. A barra permanece ligada às tarefas de Rodrigo, à confiabilidade e ao controle dos próprios dados.