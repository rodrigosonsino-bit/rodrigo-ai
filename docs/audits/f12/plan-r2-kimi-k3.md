# AUDITORIA — PLANO v2, RODADA 2

**ACHADO 1 — O mestre `RODRIGO_CLOUD=0` não cobre todos os canais que o plano afirma cobrir**
EVIDÊNCIA: §2.1 diz "um por canal (nenhum canal sem controle)" e §2.2 declara `neverSends: readonly ['audio']`. Mas nenhum controle nem teste cobre o caminho do áudio **antes** do worker: se o reconhecimento de fala for o Web Speech API do navegador (Chrome), o áudio já saiu para o Google antes de qualquer controle do plano existir. O `neverSends: ['audio']` é inferido só do H12.2, que mede apenas o que o worker manda **ao Gemini falso** — áudio enviado a qualquer outro host (STT do navegador, telemetria do Chromium) é invisível ao teste. A constante `readonly ['audio']` é decorativa exatamente do jeito que o plano diz que não seria.
GRAVIDADE: alta | CONFIANÇA: média (o plano não diz qual STT usa) | AÇÃO: declarar o mecanismo de STT no §1A e estender a medição a captura de todo o tráfego do processo, não só ao host falso.

**ACHADO 2 — §2.4: pid reciclado dentro do mesmo boot deixa órfão para sempre, contradizendo H12.4**
EVIDÊNCIA: "reutilização de pid após reboot" é o único caso tratado (`startEpochMs` anterior ao boot). Mas pid reciclado **dentro do mesmo boot**: o diretório morto `4242-1696...` passa a ter `kill(4242,0)` bem-sucedido (processo novo legítimo) e `startEpochMs` coerente com o boot → nunca removido. §6 lista "falso positivo por pid reciclado | combinado com startEpochMs vs boot" — a mitigação declarada fecha só o caso reboot, não o caso dentro do boot. H12.4 diz "reinício deixa zero órfãos": em ambiente de teste fresco isso passa trivialmente; é teste que não reproduz o modo de falha real.
GRAVIDADE: média | CONFIANÇA: alta | AÇÃO: comparar `startEpochMs` do nome com o tempo de início real do processo vivo (`/proc/<pid>/stat` campo 22), não com o boot; adicionar teste que recicla pid sem reboot.

**ACHADO 3 — §2.4: EPERM de pid de outro usuário não é tratado**
EVIDÊNCIA: o algoritmo fala apenas em "`process.kill(pid, 0)` lança ESRCH". Em sistema multiusuário ou com instâncias rodando sob usuários diferentes, pid existente de outro usuário lança **EPERM**, não ESRCH → tratado como vivo → vazamento de resíduo eterno (sub-remoção, mesmo destino do achado 2). O plano pede "varrer `.runtime/tmp/*`" sem dizer o que acontece com EPERM.
GRAVIDADE: baixa-média | CONFIANÇA: alta | AÇÃO: especificar comportamento em EPERM (tratar como vivo explicitamente e logar) e reconhecer o trade-off.

**ACHADO 4 — `redact()` pode deixar vazar chave truncada e chave fora do env atual**
EVIDÊNCIA: §2.6 "mascara `AIza[0-9A-Za-z_-]{20,}`… e remove corpo bruto (trunca a 160 caracteres)". Se a ordem for truncar-depois-mascarar está ok, mas o plano não define a ordem; um fragmento de chave partido na truncagem (ex.: `AIza` + 15 chars) não bate o `{20,}` e vaza parcialmente. Pior: a máscara do valor literal cobre só "o valor atual de `GEMINI_API_KEY` (se definido)" — a chave **antiga** (pós-rotação H12.5), ou lida de `.env` mas não exportada, não é mascarada. Também nada cobre logs/fechos do lado **Node** (`redact()` é "no worker"): qualquer URL com `?key=` logada pelo TypeScript escapa. Formato URL `?key=AIza...` contíguo é pego, mas chave URL-encoded ou em JSON escapado com quebra não é garantida.
GRAVIDADE: média | CONFIANÇA: média-alta | AÇÃO: definir ordem (mascarar antes de truncar, em string completa), mascarar também prefixo truncado (`AIza[0-9A-Za-z_-]{8,}`), e aplicar redact no Node ou provar que o Node nunca vê a chave.

**ACHADO 5 — H12.2 é parcialmente circular: compara o envio com a própria configuração**
EVIDÊNCIA: "com tudo ligado, o que sai é **exatamente** o declarado em `/api/privacy`", e §2.2 diz que a tela deriva das "**mesmas variáveis** usadas na montagem da requisição (uma função `effectivePrivacy` importada pelos dois lados)". Se `effectivePrivacy` tiver um bug, ele estará presente igualmente na montagem e na declaração → o teste passa com envio errado. Teste mais barato que falha: NENHUM nesse subcritério — ele é vácuo por construção para divergências internas. O subcritério "zero .wav" é o único independente.
GRAVIDADE: média | CONFIANÇA: alta | AÇÃO: o H12.2 deve comparar o payload capturado contra um **gabarito escrito à mão** por turno-cenário (independente do código), não contra `/api/privacy`.

**ACHADO 6 — H12.5 pode passar com chave antiga ainda válida ou por motivo errado**
EVIDÊNCIA: §2.7 "faz uma chamada de 1 token, espera falha (401/403/400 por chave inválida)". Requisição malformada retorna **400** por outro motivo → script conclui sucesso com chave revogada nada. E o critério "chave nova em uso" não tem verificação automática — só "lê a chave antiga". Mais: o procedimento depende de o usuário revogar de fato no AI Studio; o script não verifica isso, só infere.
GRAVIDADE: média | CONFIANÇA: alta | AÇÃO: exigir código/estrutura de erro específica de chave inválida (não qualquer 400), e verificar também que a chave nova **funciona** (200) e que a requisição de teste é bem-formada.

**ACHADO 7 — Teste de consistência do §2.3 não cobre dois arquivos que o próprio plano manda corrigir**
EVIDÊNCIA: §2.3 manda corrigir `.env.example` e `CLAUDE.md`, mas o teste "varre `src/frontend/` e `README.md`" — apenas. Frase proibida pode sobreviver/voltar em `.env.example` e `CLAUDE.md` sem derrubar nada (teste mais barato para falhar: colar "Nenhum serviço pago" no `.env.example`). Também: exigir o qualificador "com geração em nuvem desligada" é facilmente driblado por paráfrases fora da lista de padrões ("privado por padrão", "seus dados não saem"), aceitável, mas a lista é fixa enquanto a localização das frases é "por busca" — assimetria.
GRAVIDADE: baixa-média | CONFIANÇA: alta | AÇÃO: incluir os dois arquivos na varredura e versionar a lista de padrões com controle positivo por arquivo.

**ACHADO 8 — H12.3 "zero requisições a outros hosts" sem método de medição definido**
EVIDÊNCIA: "com a rede bloqueada **e** `RODRIGO_CLOUD=0`… zero requisições a outros hosts". Rede bloqueada já garante o resultado por construção (vácuo parcial) — o interessante seria medir **tentativas**, não sucesso. E "requisições" medido onde? Sem tcpdump/proxy declarado, qualquer emissão fora do HTTP do worker (DNS, Web Speech, verificação de certificado pelo Chromium) passa. Teste mais barato que falha: nenhum — o bloqueio de rede mascara as tentativas.
GRAVIDADE: média | CONFIANÇA: média | AÇÃO: medir com proxy/firewall logando tentativas, não bloqueio silencioso; declarar o escopo (processo? máquina?).

**ACHADO 9 — Afirmação absoluta derrubável: "a chave real nunca viaja para o host falso"**
EVIDÊNCIA: §2.5 regra 3. Garantido apenas se **todo** caminho de código que cria cliente Gemini respeitar `RODRIGO_TEST=1`. §1A.1 mostra que o v1 nem sabia que existiam **dois** clientes; um terceiro caminho (diagnóstico, script de rotação §2.7 que "faz uma chamada de 1 token" — com que base_url?) não está enumerado. O teste de mutação ("remover a regra 3 derruba ≥1 teste") protege só o caminho testado.
GRAVIDADE: baixa-média | CONFIANÇA: média | AÇÃO: trocar "nunca" por "nos dois clientes enumerados"; fazer o script de §2.7 explicitamente não usar `RODRIGO_GEMINI_BASE_URL`.

**ACHADO 10 — Contradições/decisões pendentes embutidas como se fechadas**
EVIDÊNCIA: (a) §3: D4 é "nova decisão implícita **a confirmar com o usuário**… O usuário decide.", mas H12.2 e §2.1 já assumem padrão `1` — o plano está "Para auditoria" com decisão em aberto que muda critério de aceite. (b) §0: Hermes "falhou duas vezes… nenhum arquivo produzido", mas §5.1 agenda Hermes de novo como auditor principal da rodada 2 e da auditoria de código, sem mudança de conta/quota — dependência cega num recurso já demonstrado indisponível. (c) §2.5: "igual por igualdade exata ao regex" mistura igualdade de string com casamento de regex — ambíguo na regra mais crítica do plano.
GRAVIDADE: média | CONFIANÇA: alta | AÇÃO: fechar D4 antes do aceite; plano B explícito para Hermes; reescrever a segunda checagem como `fullmatch` inequívoco.

**ACHADO 11 — Efeitos colaterais não auditados: env/proc e erro de disponibilidade**
EVIDÊNCIA: nada no plano cobre a chave visível em `/proc/<pid>/environ` para qualquer processo do mesmo usuário, nem permissões de `.env`. Em app local single-user talvez aceitável, mas a promessa de privacidade do plano não delimita ameaça. "nenhum canal sem controle" e "keyPresent: nunca valor nem tamanho" não mencionam esse plano de ameaça.
GRAVIDADE: baixa | CONFIANÇA: média | AÇÃO: declarar modelo de ameaça (ameaças na mesma máquina estão fora?) no §7.

---

**VEREDITO: REJEITADO para implementação sem correções.** Os achados mais altos da rodada 1 foram parcialmente bem tratados (regex da URL agora é sólido na especificação; controle positivo no §2.3 é boa prática), mas: H12.2 tem subcritério circular por construção (achado 5), H12.5 pode passar com chave válida (achado 6), a limpeza por pid tem falso negativo real não mitigado (achados 2-3) e o `neverSends: ['audio']` / "nenhum canal sem controle" não resiste a um STT em nuvem no navegador (achado 1). Há ainda uma decisão de usuário (D4) embutida como resolvida.

**NÃO CONSEGUI VERIFICAR:** o documento v1 e o código-fonte citados (linhas de `worker.py`, `sessionManager.ts`, `audioStore.ts`, `index.html`) — confio nas citações sem poder confirmá-las; qual mecanismo de STT/TTS o frontend usa (decisivo para o achado 1); se o relato do agy sobre redirect 307 do `httpx` é real (o próprio plano o marca SUPOSIÇÃO não reproduzida); a bateria de 25 payloads e seus resultados; e se o esquema `effectivePrivacy` descrito corresponde ao que será implementado.
