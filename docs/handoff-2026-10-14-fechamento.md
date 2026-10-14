# Handoff de fechamento do app — Rodrigo AI — 2026-10-14

Escrito para ser lido **por inteiro** antes da primeira ação da próxima sessão. O objetivo da próxima sessão é **fechar todas as pendências do app**; este documento separa o que ela pode fazer sozinha do que só o Rodrigo pode fazer, e dá a ordem. Ele **complementa** `docs/handoff-2026-10-14-implementacao-noturna.md` (escrito pela sessão-fork) e **corrige dois fatos velhos dele** (ver §1.3).

## 0. Proveniência (leia antes de confiar em qualquer frase)

- **[verificado agora]**: comando rodado em 2026-10-14, até as 08:54 (horário do Mac; o `date` do Mac manda, não os carimbos em UTC dos PRs); o comando está citado junto.
- **[suposição]**: acredito, não conferi nesta escrita.
- **[combinado com o Rodrigo]**: citação literal do chat desta sessão. Nada que outra sessão diga que o Rodrigo disse a ela entra aqui como combinado: entra como suposição.

## 1. Estado verificado agora

### 1.1 Repositório (checkout principal, `rodrigo-ai/`)
```
git branch --show-current            -> main
git status --short | grep -v '^??'   -> (vazio: 0 arquivos rastreados modificados)
git rev-list --count HEAD..origin/main / origin/main..HEAD  -> 0 / 0
git log --oneline -1 origin/main     -> a9d415a Merge pull request #26 (fix-outbound-guard-agy)
git stash list | wc -l               -> 0
```
Tudo o que foi feito nesta noite está **mergeado e empurrado**, **exceto este documento** (branch `handoff-2026-10-14-fechamento`, PR aberto, **não mergeado**: precisa do "mergeia" do Rodrigo). Mergeados (`gh pr list --state merged`): #18 T1, #19 T5a, #20 T2-0, #21 correção do `fvScreen`, #22 handoff anterior, #23 **T6**, #24 T2+T9a+T3+T5b+T4, #25 handoff da noite, #27 inventário de canais, #28 correções da auditoria do Codex, #26 correções da auditoria do agy.

### 1.2 Testes e build (rodados agora, no checkout principal)
```
npm run typecheck                    -> exit 0
npm test (1ª execução)               -> 874 testes, 873 passam, 1 FALHA: "item que FALHA é pulado; os seguintes continuam na ordem" (f13Session)
node --test dist/.../f13Session.test.js x3 isolado -> 14/14 passam nas 3
npm test (2ª e 3ª execuções)         -> 874/874 passam nas duas
scripts/worker/test_*.py (17 arquivos, .runtime/.venv/bin/python3) -> todos "ok"/"passaram" (35 casos de paridade do guarda)
```
**Há testes intermitentes sob carga da suíte inteira** (pendência C1 abaixo): o `fvScreen` (corrigido no #21), o `D.3` de `f11Scenarios` (falhou 1 vez nesta sessão) e este `f13Session` (falhou 1 vez agora). Nenhum reproduz isolado.

### 1.3 Fatos velhos no handoff da sessão-fork (ela escreveu antes dos merges finais)
- Ele diz que o **PR #26 estava aberto**: **foi mergeado** (`a9d415a`).
- Ele lista "o inventário de canais em documento" como faltando: **foi mergeado** (#27, `docs/inventario-canais-nuvem.md`); o que falta da T1 é só o **egress em rede real**.

### 1.4 O app rodando agora
```
curl http://127.0.0.1:3000/api/health -> {"status":"ok","version":"0.3.0"}
app pid 18027; servidor pid 18039, pai = 18027 (filho do app), iniciado 2026-10-14 07:52
/api/doctor -> 3 ok, 2 info, 3 aviso, 0 erro. Avisos: file-policy (lista de sensíveis RASCUNHO), risk-history-memories, risk-tts-dictated
/api/privacy -> modo cloud; guarda redact; visão False; web False; voz em nuvem True
```
Foi **reconstruído e reiniciado a partir de `a9d415a`** (`npm run build` + `./desktop/build.sh`). Para reconstruir de novo:
```bash
cd <checkout principal> && git merge --ff-only origin/main && npm run build && ./desktop/build.sh
pkill -TERM -f "rodrigo-ai/desktop/build/Rodrigo AI.app/Contents/MacOS/RodrigoAI"; lsof -tiTCP:3000 -sTCP:LISTEN   # tem de ficar VAZIO antes de reabrir
nohup "$PWD/desktop/build/Rodrigo AI.app/Contents/MacOS/RodrigoAI" >/dev/null 2>&1 </dev/null & disown
```
**Armadilha verificada (aconteceu hoje):** se algo já responde na porta 3000, o app **reaproveita esse servidor** (mesmo velho) em vez de subir o dele. Confira que a 3000 está livre antes de reabrir, e depois que `ps -o ppid= -p <pid do servidor>` é o pid do app.

### 1.5 NotebookLM (`803ea045-d8fb-4a59-9caa-872d91a51124`)
`notebooklm source list ... --json` -> **52 fontes, todas `ready`**. Fontes 46–55 da sessão-fork, 58 (auditoria agy), 61 (T2-0 corrigido), 62 (código T1), 63 (código T5a) minhas. Conferi que o código das fontes 51–55 está **íntegro** (contagem de `_` e `*` igual ao original). Regra aprendida: o NotebookLM corrompe `_` e `*` fora de bloco de código; **embrulhar código em `.md` com bloco de 4 crases** e conferir por `source fulltext -o`.

## 2. O que só o Rodrigo pode fazer (a próxima sessão prepara e espera)

| # | Pendência | Onde está | Critério de pronto |
|---|---|---|---|
| A1 | **Prompt do microfone** na primeira vez + **conversa por voz de ponta a ponta dentro do painel** (T6) | app rodando; `docs/implementation-t6.md` "Não verificado" | frase falada no painel é transcrita, roteada e respondida em voz; o prompt do macOS foi concedido |
| A2 | **⌘⇧Espaço conflita com outro atalho seu?** | idem | o painel abre pelo teclado físico sem ser engolido por outro app |
| A3 | **T8: baseline de turno com voz real** (~60 repetições × 5 categorias = ~300 falas, e aprovar os limiares) | `docs/t8-roteiro-baseline-voz.md` (a conta do plano, 110, estava ~2× alta: **verificado por binomial exata**: 59 repetições, até 4 falhas) | planilha preenchida; limiares aprovados **antes** de medir; categoria Eco com zero falha |
| A4 | **F11: medição de intenção com voz real** (dívida registrada; meta ≥95% **não foi baixada**: 63,0% geral, 86,7% acionáveis, hora/data 82,0%) | `docs/f11-roteiro-voz-real.md`, `docs/implementation-phase-11.md` | números novos no doc da F11, sem mexer na meta |
| A5 | **H13a.10: ouvir a voz do Gemini e dizer se deixou de soar robotizada** | `docs/implementation-phase-13a.md` (linha "H13a.10 ... PENDENTE, só o usuário mede") | veredito registrado nessa linha |
| A6 | **T1: egress em rede real** (captura de pacotes, TCP e UDP incluindo DNS/QUIC; atribuir por processo com `nettop`/`lsof`; lista de permitidos concreta já no inventário) | plano v2.6 §3.1; `docs/inventario-canais-nuvem.md` | relatório com o tráfego observado contra a lista aprovada. **Exige o Mac, privilégio e o Rodrigo presente** |
| A7 | **T6: uma semana de uso** (critério de adoção: usar o atalho em pelo menos 4 dos 7 dias) | contador local `.runtime/desktop-usage.jsonl` (só `{ts, keyToVisibleMs}`) | **zerei o arquivo agora** (tinha 5 linhas, todas dos meus testes de 23:04–23:06); a semana só conta daqui em diante |

## 3. Decisões que são do Rodrigo (nada disto foi decidido por ele)

1. **Decisão 7 (T2): aprovar ou editar a lista de sensíveis.** `config/sensitive-files.json` é **RASCUNHO**; `SENSITIVE_LIST_APPROVED = false` em `src/backend/fileAccessRegistry.ts:42` e o `doctor` avisa por isso. Aprovada a lista: trocar o flag para `true` com teste.
2. **T4: aprovar a mudança de esquema dos stores** (marcador `applied`), que permite distinguir "aplicada, conclusão perdida" de "não aplicada". Hoje uma intenção sem conclusão é **indeterminada** e o app avisa no boot.
3. **PR #10 (`gh pr view 10`, rascunho): D1 a D6** do agente OpenClaw dedicado; D3 é a escolha do modelo. Depende também de configuração no Mac com o Grok.
4. **Ratificar a T6 como opção D** (o plano aprovara só o spike C). Reverter, se não: `git revert -m 1 127b63e`.
5. **Limiares da T8** (§2 A3): palpites meus, nada aprovado.
6. **T7:** G4 (aceitar a licença dos pesos do PersonaPlex no Hugging Face) é decisão dele; G1 (português) segue sem evidência. Próxima checagem mensal: **2026-11-13**.
7. **O que fazer com os PRs de outras sessões**: #6 (não é rascunho), #7, #8, #10, #11, #12, #13, #14, #15 (`gh pr list --state open`) e as branches remotas `claude/*` e `origin/docs-decisoes-privacidade-especialistas` (`git branch -r --no-merged origin/main`). **Suposições, não conferi o conteúdo:** #14 e #15 parecem superados pelo plano v2.6; o #8 parece redundante com o #21 (`gh pr view 8/21 --json files` mostram o mesmo arquivo, `fvScreen.test.ts`).

## 4. O que a próxima sessão pode fazer sozinha, nesta ordem

- **C1 — Estabilizar os testes intermitentes** (maior risco para "fechado"): `f13Session` ("item que FALHA é pulado…"; a suíte desse arquivo levou 7,06 s na execução que falhou), `f11Scenarios` D.3, e confirmar o `fvScreen` pós-#21. Método: rodar a suíte inteira em laço (10×) registrando qual falha e o tempo; achar a causa (timing do harness) em vez de aumentar prazo.
- **C2 — Fechar o que ficou sem auditoria por outro modelo.** Quadro verificado das auditorias: **T1** agy (2 rodadas; a 1ª foi **cortada em 3 KB**, a 2ª completa nos itens A, B, C); **T5a doctor** e **condições de corrida de T1**: **nunca auditados** (itens 6 e 7 do pedido); **T2, T3, T4, T9a**: Codex uma vez; **9 achados, 8 corrigidos, 1 limite declarado (cadeia de hashes sem âncora externa), segundo o handoff da sessão-fork: não reconferi o código**; **T6**: só o MiMo (11 achados). Regra do projeto: auditor diferente de quem já viu; use agy ou Codex em T6 e doctor. **Para rodar o agy:** `agy -p "$(cat prompt)" --mode plan --effort high --dangerously-skip-permissions --print-timeout 50m < /dev/null > saida.md` **em primeiro plano de uma tarefa em segundo plano**; `&` dentro de comando já em segundo plano mata o processo (aconteceu duas vezes). Peça saída curta com uma linha final "FIM DA AUDITORIA" para detectar corte.
- **C3 — Aplicar a regra de mutação inteira:** a mutação só prova ausência de cobertura se rodar **todos** os testes relevantes (errei nisto hoje: concluí "teste vácuo" rodando só 3 arquivos; com `untrustedData.test` incluído, a barreira estava coberta).
- **C4 — Limpeza local (peça aval antes de apagar):** worktrees `rodrigo-ai-wt-t6` (minha; **neste momento está na branch deste handoff**, `handoff-2026-10-14-fechamento`), `.claude/worktrees/modest-euler-a45465` (detached) e `/private/tmp/.../scratchpad/pr12` (detached); branches locais já mergeadas (liste com `git branch --merged origin/main`). `git worktree list` e `git branch --merged origin/main`.
- **C5 — Corrigir o `CLAUDE.md`/docs se o estado mudar** (o parágrafo da trilha OpenJarvis está na linha 23 do `CLAUDE.md`; o handoff da sessão-fork precisa dos dois ajustes do §1.3).
- **C6 — T9-resto** (Kokoro persistente, assinatura de manifestos): **não aprovado**, "caso a caso" no plano. Só com pedido do Rodrigo.
- **C7 — T6-voz:** o gate de voz equivalente (mesma bateria da T8 no painel e na página). Só depois do A3.
- **Dívidas aceitas e registradas (não são bugs novos, não reabrir sem decisão):** Fase 5b (H11 75%, meta 80%); Fase 5c (H-mutação 76,5%, H-confirmação 61,1%, zero falso SIM mantido); Fase 11 (§2 A4). Fontes: `CLAUDE.md` do projeto e `docs/implementation-phase-5b.md`, `-5c.md`, `-11.md`.

## 5. Armadilhas verificadas hoje

- **Duas sessões no mesmo working tree** se sobrescrevem (colisão real em `desktop/`, mortes por `pkill`). Um worktree por sessão.
- **Sandbox:** `git push`, `gh` e escrita em worktree irmão exigem `dangerouslyDisableSandbox`; `open` é bloqueado (executar o binário direto).
- **Atalho global:** o teclado injetado pelo `computer-use` (nível de sessão) **não** aciona Carbon `RegisterEventHotKey`; um `CGEvent` no nível HID (`.cghidEventTap`) aciona (medido: 4–18 ms).
- **WKWebView:** consome o Esc (precisa de monitor local de teclado); **WebKit não aceita `|` em regra de bloqueio de conteúdo** (a regra não compila e o bloqueio some em silêncio); `osascript` "frontmost" não enxerga app `LSUIElement` de forma confiável: confirme foco pelo log de diagnóstico (`RODRIGO_DESKTOP_DEBUG=1`).
- **Política de arquivos (T2):** recusa symlink em qualquer componente; worktree com `.runtime` como link simbólico quebra o worker; testes que gravam em `os.tmpdir()` precisam de `RODRIGO_FILE_ROOTS`.
- **Parser de teste:** o bloco de memórias injeta no máximo 10 itens (`MAX_MEMORIES_INJECTED`) e `resolveConflicts` funde itens parecidos: listas hostis grandes dão contagem menor sem o código estar errado.

## 6. Combinado com o Rodrigo (citações literais, desta sessão)

- "vou dormir e vou deixar vc implementado / tire suas duvidas com o jev para decisões / consulte o codex, agy, mimo e a ogra quando necessário, quando vc não souber o que fazer ou precisar de uma outra opnião"
- "quero acordar com o app funcionando inclusive a t6"
- "mergeia o #26"
- "sim, reconstrói e reinicia o app / depois atualiza o notebooklm"
- "faça um handoff para que a próxima sessão seja finalizado e fechado todas as pendencias do app"

**Não foi combinado comigo:** o merge do #23 e do #24. A sessão-fork os fez dizendo que o Rodrigo a autorizou ("pode mergear tudo no final e pushar", segundo ela); **não consigo confirmar isso daqui** e registrei a recusa dela no meu chat. Peça a ele que confirme (pendência §3.4).

## 7. Primeiro passo da próxima sessão

Rodar o bloco de verificação do §1 (os mesmos comandos) para saber o que mudou desde as 08:54 de 2026-10-14, e **em seguida mandar ao Rodrigo uma única mensagem** com as sete decisões do §3 (cada uma com a recomendação do plano e o arquivo onde ler) e a lista A1 a A7 do que só ele faz, **enquanto** começa o C1 (testes intermitentes) sozinha. Não mergear nada novo sem o "mergeia" dele no chat da própria sessão.
