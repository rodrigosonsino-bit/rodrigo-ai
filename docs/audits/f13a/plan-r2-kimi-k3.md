# Auditoria adversarial — rodada 2, Fase 13a v2

Analisei a v2 contra os achados que ela diz ter incorporado, e principalmente o que ela introduziu de novo. Observação prévia: não vejo o repositório; quando a evidência for do plano apenas, cito o plano, e onde depender de código invisível, digo isso.

---

**ACHADO 1** (uma frase): As threads de `synthesize` impedem o processo Python de terminar se o stdin fechar com sínteses em curso, deixando o processo órfão pendurado por até o prazo HTTP (≥10 s por thread) ou para sempre se `.part`/fechamento travar.

EVIDÊNCIA: "O leitor de stdin o despacha a um `ThreadPoolExecutor(max_workers=2)` dentro do worker". O plano nunca diz o que acontece quando o processo pai morre ou o stdin fecha (que é como o Node encerra o worker): um executor sem `shutdown(wait=False, cancel_futures=True)` (nome de API de memória) no recebimento de EOF/SIGTERM bloqueia a saída do processo, e o único tratamento de cancelamento descrito é reativo a comandos NDJSON (`cancel_synth`), que deixam de chegar quando o stdin fecha.

GRAVIDADE: ALTA — CONFIANÇA: 85% (comportamento de shutdown depende de código de worker.py não mostrado; o motivo de atualização do laço e o caminho de EOF não constam do plano).

AÇÃO RECOMENDADA: especificar no §4.2 o caminho de encerramento: ao EOF do stdin, setar todos os `cancel_event`, abortar futuros pendentes e sair sem esperar as threads; teste H13a.x novo "kill do pai com síntese em curso" com asserção de saída < N segundos.

---

**ACHADO 2**: A regra "frase de índice 0 nunca é coalescida" não cobre a pergunta de mutação quando ela é emitida como índice 0 — e principalmente quando não é.

EVIDÊNCIA: "pergunta de mutação (`armedMutation.question`)… e a **frase de índice 0 de cada turno nunca são coalescidas**". O plano lista os dois como invariantes separados, o que é bom, mas o §4.3 não especifica a *ordem de decisão*: se a pergunta de mutação chega como frase de índice ≥ 1 do buffer, ela é identificada por comparação de texto com `armedMutation.question` — porém `markPlayed` exige igualdade exata e a coalescência junta textos, então qualquer duplicação sutil (duas frases do turno com o mesmo texto, ou a pergunta aparecendo duas vezes) faz `find(e.text === text)` casar com a entrada errada. O plano nada diz sobre cópias idênticas de texto no mesmo turno: o buffer de índice ≥1 pode conter uma frase cujo texto é idêntico ao da frase 0 ou à pergunta; ao ser coalescida com vizinhas o grupo nunca bate com `markPlayed` (isso está coberto), mas se a frase isolada anterior for marcada, a identidade por *texto* em vez de por id continua sendo frágil — e o plano não transfere essa fragilidade para nenhum teste.

GRAVIDADE: MÉDIA — CONFIANÇA: 70% (a comparação por string consta do contexto: "igualdade exata"; se torna crítica só em conteúdo duplicado).

AÇÃO RECOMENDADA: indexar `markPlayed`/pairs por id de sentença emitida, não por texto; em H13a.4 ou em teste novo, incluir turno com frases duplicadas e com a pergunta de mutação em posições ≥1.

---

**ACHADO 3**: A política "falha ao ler o arquivo de orçamento = orçamento esgotado" converte qualquer corrupção transitória ou falha de I/O em desligamento do TTS até a virada do dia, e com duas instâncias do app o contador perde updates de forma silenciosa.

EVIDÊNCIA: "Falha ao ler ou escrever o arquivo = **orçamento do dia tratado como esgotado** (cai no `say`), nunca 'ilimitado'." e ".runtime/tts-budget.json, escrito de forma atômica (`.tmp` + `rename`)". Duas fragilidades aqui que a rodada 1 não teria apontado: (1) `.tmp`+`rename` não é atômico *entre processos* — duas instâncias do Rodrigo (o usuário abriu duas vezes, ou dev + prod no mesmo `.runtime`) fazem leitura-modificação-escrita lost-update, e o arquivo pode ser lido parcialmente pela outra instância → "esgotado" espúrio por horas; (2) um relógio do sistema que mude (NTP, viagem, suspensão) pode mudar o "dia America/Los_Angeles" e reiniciar a cota local para 90 enquanto o Google ainda aplica o dia antigo → rajada de 429s que o plano classifica depois como por-minuto (próximo achado).

GRAVIDADE: MÉDIA — CONFIANÇA: 80% (o mecanismo de escrita está no plano; a presença ou não de locking é código não visto).

AÇÃO RECOMENDADA: distinguir "arquivo ausente" (dia novo, começa do zero) de "arquivo corrompido" (fail-closed ok, mas com log e contador de ocorrências); lock de arquivo ou serialização por turno; documentar que duas instâncias compartilham cota e o comportamento esperado.

---

**ACHADO 4**: O desenho do 429 transforma conflito de cota em ambiguidade de classificação: um 429 por minuto com `quotaId` ausente/desconhecido bloqueia só 60 s, mas o `retryDelay` informado pelo Google pode exceder isso, e um 429 `PerDay` com assinatura irreconhecível é tratado como por-minuto, levando a tentativas a cada 60 s que desperdiçam cota diária já esgotada — cobrada mesmo rejeitada em alguns regimes (alegação de memória: requests rejeitados por cota normalmente não consomem, mas o plano assume isso sem dizer).

EVIDÊNCIA: "`quotaId` **desconhecido ou ausente → trata como por minuto, bloqueio máximo de 60 s**". Se o modelo renomear o quotaId do 429 diário (o plano mesmo admite: "Só a assinatura por minuto está observada hoje"), o comportamento padrão é retry a cada 60 s contra uma cota diária zerada — cada retry na janela deslizante local reconta como pedido de orçamento? O §4.4 não diz se pedidos que recebem 429 descontam do contador local da janela de 8/min e do contador diário de 90.

GRAVIDADE: ALTA — CONFIANÇA: 75%.

AÇÃO RECOMENDADA: especificar no §4.4 se 429/erros descontam dos contadores locais (recomendo: pedidos já enviados ao Google descontam sempre, porque o Google os conta; pedidos bloqueados localmente, não); no fallback de quotaId desconhecido, dar backoff exponencial (não fixo de 60 s) com teto, e logar o corpo completo (isso já está parcialmente em H13a.12).

---

**ACHADO 5**: A reserva de 2 pedidos por turno é incompatível com a coalescência que ela mesma justifica, e cria desperdício contábil: um turno de 6 frases coalesce para 3 pedidos (0 sozinho + grupos), mas se o saldo cair o turno já "reservou" nada de verdade — "exigir saldo para 2" não reserva nada atomicamente; dois turnos concorrentes (ou pedido de reserva + síntese em andamento) podem ambos passar no check e depois dividir um saldo de 2.

EVIDÊNCIA: "antes de sintetizar a primeira frase de uma resposta, o limitador exige saldo para **pelo menos 2 pedidos** (minuto e dia)". Checar saldo ≠ reservar. Se não há decremento atômico no momento do check, a "reserva" é uma verificação TOCTOU. E pior: o plano nunca explica por que 2 — com coalescência, turnos médios de 2–8 frases (H13a.1) consomem 2–4 pedidos; reservar 2 não evita "trocar de voz no meio" para turnos longos, só adia. O risco "Troca de voz no meio da resposta | reserva por turno" no §5 é, portanto, tratamento parcial vendido como tratamento.

GRAVIDADE: MÉDIA — CONFIANÇA: 75% (a atomicidade depende de código não visto; a insuficiência do número 2 decorre da aritmética do próprio plano).

AÇÃO RECOMENDADA: decrementar o orçamento no momento da concessão (reserva real), estornar em 429-não-contado se o §4 confirmar; corrigir a tabela §5 para "reduz, não elimina"; ou fixar o limite do buffer em 2 frases para que 2 pedidos realmente bastem na maioria dos turnos.

---

**ACHADO 6**: Em §4.2, a normalização RMS-alvo com teto de ±6 dB é internamente contraditória com H13a.5: o próprio plano mede dispersão de 8,2 dB (modelo 3.1) e 4,5 dB (Flash-Lite); com ganho limitado a ±6 dB, frases na ponta da dispersão ficam a mais de 1,5 dB do alvo e reprovam o critério pelo desenho, sem defeito de implementação.

EVIDÊNCIA: "ajusta o ganho para RMS-alvo de −17,0 dBFS, limitando o ganho a ±6 dB e a pico de −1 dBFS" e H13a.5: "o RMS de **todas** as frases… fica a ≤ **1,5 dB** de −17,0 dBFS". Duas falhas adicionais: (1) o limiter "pico de −1 dBFS" aplicado depois do ganho comprime picos de forma diferente por frase, mudando o RMS medido pós-limiter — a ordem das operações não está especificada e dois implementadores razoáveis mediriam diferente; (2) frases curtas ou baixas ("Oi." do H13a.12) têm RMS dominado pelo silêncio do início/fim do áudio: se a medição de RMS incluir o padding do PCM streamado, o ganho calculado amplificará ruído de fundo em +6 dB e ainda falhará o alvo — o plano não diz se mede RMS com gate de atividade.

GRAVIDADE: ALTA — CONFIANÇA: 70% (a contradição numérica vem dos dados do próprio plano; o comportamento do limiter depende de implementação).

AÇÃO RECOMENDADA: H13a.5 deve tolerar frases que saturaram o teto de ganho (reportar quais saturaram) ou subir o teto; especificar RMS com gate de silêncio (ex.: apenas amostras acima de −50 dBFS) e a ordem ganho→limiter→RMS-verificação.

---

**ACHADO 7**: O custo do barge-in na coalescência é "quantificado" por H13a.11, mas o critério não tem limite de reprovação — é um teste inalcançável por design (jamais pode falhar), e portanto não protege a inegociável "zero falso histórico".

EVIDÊNCIA: "**H13a.11** — barge-in dentro de um grupo coalescido: medir em 20 interrupções simuladas quantas frases ouvidas deixaram de entrar no histórico… e reportar." "Medir e reportar" sem threshold não é critério de aceite: qualquer resultado passa, inclusive 20/20 repetidas. O §4.3 admite que o modelo pode repetir o que o usuário já ouviu — isso degrada o produto sem nenhum gate.

GRAVIDADE: MÉDIA — CONFIANÇA: 90%.

AÇÃO RECOMENDADA: dar a H13a.11 um teto (ex.: ≤ 20% de frases repetidas nas 20 interrupções) ou rebaixá-la a "métrica informativa" na tabela, para não inflar a lista de "critérios".

---

**ACHADO 8**: A regra "`RODRIGO_CLOUD_TTS` fica efetivamente desligado quando `RODRIGO_SEND_HISTORY=0`" mistura duas semânticas de privacidade e cria uma config mentirosa, e a recomendação da D-b (memórias na nuvem por padrão quando `SEND_MEMORIES=1`) vaza para o TTS texto que o usuário ditou — conteúdo que a Fase 12 protegia por flag específica e que não é "fala do assistente".

EVIDÊNCIA: "`RODRIGO_CLOUD_TTS` fica **efetivamente desligado** quando `RODRIGO_SEND_HISTORY=0`" e D-b: "**sim por padrão** (uma voz só), **local (`say`) quando `RODRIGO_SEND_MEMORIES=0`**". Dois problemas distintos: (1) `SEND_HISTORY=0` é uma flag sobre o *contexto da geração*; inferir dela uma intenção sobre a *voz da saída* é teleologia o plano não justifica — o caso (b)/(c) que ela supostamente resolve já existiria com history ligado (frases cortadas por barge-in também não entram no histórico com `SEND_HISTORY=1`), ou seja, a regra tem furos: não impede o envio de frase não-ouvida no caso padrão; (2) na D-b, "prévia de lembrete/nota" que repete conteúdo ditado é texto do *usuário* saindo por um canal novo — ligar isso por padrão contradiz o espírito da Fase 12 ("zero falso... " de outra natureza) e o plano recomenda o default mais vazador sem teste de que o usuário entendeu.

GRAVIDADE: ALTA — CONFIANÇA: 80% (a semântica das flags consta do contexto; a decisão D-b está marcada como aberta, o que mitiga).

AÇÃO RECOMENDADA: não acoplar flags; tratar o problema real (barge-in envia texto nunca ouvido) diretamente: exigir que frases de turno só vão ao TTS-cloud após iniciar, ou aceitar e divulgar consistentemente para todos os valores de `SEND_HISTORY`. D-b: default recomendado deveria ser local quando o conteúdo repetido veio do usuário.

---

**ACHADO 9**: Nada no plano trata mistura de vozes num mesmo turno ao contrário do que a tabela §5 afirma, nem a ordem de reprodução quando um grupo falha e o seguinte conclui — o cliente pode receber `sentence_audio_ready` do item 2 e não do item 1 (429+fallback assíncrono no `say`), e `sentenceIndex` "monotônico por item emitido" não garante monotonia de *entrega*, porque o `say` é outro caminho de código com latência diferente.

EVIDÊNCIA: "`sentenceIndex` emitido ao cliente é **monotônico por item emitido**, não por frase de origem" e "Se o saldo acabar depois de o turno começar no Gemini, o resto do turno cai no `say`". O fallback `say` no meio da sequência ("não troca de voz no meio da resposta" prometido no §5 só vale por turno no *início*) produz exatamente a troca de voz que a tabela diz tratar, e não há nenhuma palavra no plano sobre reordenação, timeout do cliente aguardando item 1, ou falha do próprio `say` (sem segundo fallback especificado — se o `say` falhar, a frase simplesmente some? `markPlayed` nunca dispara? O turno fica sem histórico de algo?).

GRAVIDADE: ALTA — CONFIANÇA: 90% quanto à omissão (o plano é a evidência); o comportamento real depende de sessionManager.ts não visto.

AÇÃO RECOMENDADA: §4.3 deve definir: serialização de emissão por turno (item n+1 não é emitido enquanto n não resolveu, com timeout), comportamento em falha do `say` (pular frase + log + nunca bloquear o turno), e corrigir o §5 para admitir troca de voz intra-turno quando o orçamento acaba.

---

**ACHADO 10**: H13a.2 e H13a.7 medem egresso, mas nenhum critério testa a regra de privacidade nova do §3 (`SEND_HISTORY=0` ⇒ TTS local) nem a D-b — o §6 inteiro é testável sem que a regra de acoplamento de flags exista.

EVIDÊNCIA: H13a.2 testa `RODRIGO_SEND_HISTORY=0` apenas quanto a "zero conexão de saída" — o que na verdade *testa* a regra nova, retiro a parte cega. Mas a D-b ("memórias via TTS quando `SEND_MEMORIES=1`") não tem nenhum critério: nada verifica que com `RODRIGO_SEND_MEMORIES=0` as prévias de lembrete caem no `say`. Uma implementação que ignore essa ramificação passa em todos os H13a.

GRAVIDADE: MÉDIA — CONFIANÇA: 85%.

AÇÃO RECOMENDADA: adicionar H13a.14: matriz (SEND_MEMORIES × tipo de frase) × provedor usado, contra o provedor falso, cobrindo a decisão D-b qualquer que seja a resposta do usuário.

---

**ACHADO 11**: O orçamento dos testes reais (H13a.3: 20 frases; H13a.6: até 30 turnos × ~3 pedidos = até ~90; H13a.12: esgota o dia — 100!) conflictua entre si e com o uso real: H13a.12 por definição zera a cota diária, e se rodar antes ou no mesmo dia que H13a.6 ("partir de uma cota limpa") ou que uma sessão real do usuário, invalida os demais ou deixa o assistente mudo pelo resto do dia.

EVIDÊNCIA: "H13a.12… esgota a cota do dia com frases mínimas" e "H13a.6… sessão de **até 30 turnos reais a partir de uma cota limpa**" com `RODRIGO_TTS_RPD=90` contra cota de 100/dia (de memória/contexto, mas figura no contexto). O plano não define ordem de execução nem multi-dia para a suíte, e 30 turnos de H13a.6 podem exceder 90 pedidos com turnos de 8 frases (8 frases → 0 isolado + ceil(7/3) grupos ≈ 4 pedidos; 30×4=120 > 90) — i.e., H13a.6 pode *sempre* esgotar o orçamento no meio, contaminando a métrica "quedas por esgotamento reportadas à parte" que passa a dominar o resultado.

GRAVIDADE: MÉDIA — CONFIANÇA: 80% (aritmética do próprio plano; depende da distribuição real de frases).

AÇÃO RECOMENDADA: §6 deve fixar: H13a.12 roda por último e em dia próprio; orçamento total da suíte tabelado; H13a.6 limitado a turnos curtos ou com `RPD` elevado só no teste via arquivo de orçamento injetado.

---

**ACHADO 12 (omissão)**: O plano não define timeout do cliente para `sentence_audio_ready`, o que acontece quando `cancel_synth` chega para um reqId já concluído ou desconhecido, e se pedidos cancelados contabilizam orçamento local — pontas soltas que qualquer implementação razoável resolverá de formas incompatíveis entre si.

EVIDÊNCIA: §4.2 lista `cancel_synth {reqId}` e "o cancelamento de turno existente passa a cancelar também todas as sínteses do `turnId`", mas não há semântica de corrida: uma síntese que cancelou localmente (prazo de 8 s) pode estar ainda cobrando no Google (HTTP de ≥10 s em curso? o plano diz "fecha o fluxo" — fechar o stream cliente não cancela a cobrança necessariamente; de memória, tokens gerados até o cancelamento são cobrados, o plano admite na tabela de custos um cálculo por minuto sem contar cancelados). Pedidos cancelados por barge-in na metade do stream são custo real não mencionado no §5 "Custo ~US$ 0,009/min".

GRAVIDADE: MÉDIA — CONFIANÇA: 75% (cobrança em cancelamento: de memória do modelo de billing por tokens gerados).

AÇÃO RECOMENDADA: §4.4: pedido despachado ao worker = descontado do orçamento; §5: adicionar linha "custo de frases canceladas por barge-in"; §4.2: idempotência de `cancel_synth` (no-op + ack) e timeout de prontidão no cliente com fallback para silêncio.

---

**ACHADO 13**: A premissa do achado 3 da rodada 1 ("mínimo de 10 s ao Google") é tomada como fato para impor o prazo local de 8 s, mas o prazo local de 8s com latência real mediana ~2s e máximo ~7s deixa margem de apenas ~1s sobre o pior caso observado — frases longas ou rede lenta cairão sistematicamente no `say` por timeout local, e H13a.3 (p95 ≤ 6,0s) não sobra margem: p95 de 6,0s contra corte de 8s implica que qualquer degradação futura gera taxa de fallback massiva sem reprovar teste nenhum (H13a.6 permite até 5% de quedas por erro, mas não mede *timeout local* separado de erro do Google... na verdade H13a.6 inclui timeout; o furo é que 5% de frases × pico de uso ainda é UX degradada contínua sem alarme).

EVIDÊNCIA: "frase inteira mediana ~2 s, máximo ~7 s" (contexto) + "O prazo de 8 s por frase é **imposto localmente**" + "quedas para o `say` por **erro** (429, 5xx, timeout) ≤ 5% das frases".

GRAVIDADE: BAIXA — CONFIANÇA: 65% (depende da distribuição real, que só o autor viu).

AÇÃO RECOMENDADA: subir o prazo local para valor com margem sobre o p95 medido (ex.: 12 s, se o piso do Google permitir), ou justificar 8 s com o histograma; H13a.6 separar timeout-local de 429/5xx.

---

## VEREDITO: REJEITADO

A v2 incorporou bem os 21 achados, mas introduz defeitos novos nos dois pontos mais delicados (ciclo de vida das threads no shutdown e coerência interna normalização↔H13a.5), omite semântica de ordem/reordenação e de custo de cancelamento, e tem um critério (H13a.11) e um "tratamento" de risco (troca de voz intra-turno) que não fazem o que anunciam. Nada disso exige redesenho — são ~3 dias de especificação — mas aprovar como está transferiria ambiguidades para o implementador.

## O que não consegui verificar
- Se worker.py já tem handler de EOF/SIGTERM (achado 1 depende disso).
- Se a emissão de `sentence_audio_ready` é serializada hoje em sessionManager.ts (achado 9).
- Se `markPlayed` tem proteção contra textos duplicados no turno (achado 2).
- Se os contadores de orçamento existem com qualquer atomicidade entre processos (achados 3/5).
- A distribuição real de latência (achado 13) e a semântica de cobrança do Google em streams cancelados (achado 12 — de memória).
- Se `build_gemini_client` aceita `timeout_ms` > 10 000 sem efeito colateral nos outros canais (geração compartilha o cliente?).
