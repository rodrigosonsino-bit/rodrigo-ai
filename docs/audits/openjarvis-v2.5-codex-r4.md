# Auditoria adversarial do plano OpenJarvis v2.5: rodada 4 (Codex, gpt-6-luna)

- **Alvo:** docs/plans/openjarvis-voz-desktop-v2.md no commit 3dc2a01, sha256 da época do HEAD (plano sem alterações pendentes)
- **CLI:** Codex 0.162.0-alpha.17.2 (binário do app ChatGPT), `-s read-only`, `-m gpt-6-luna` (cabeçalho da execução), esforço medium. Escolhido por ser o modelo descrito como "fast and affordable"; o catálogo não traz preços.
- **Data:** 2026-10-13. Mesmo fornecedor e CLI da rodada 1, **modelo e versão do plano diferentes**; o Hermes falhou duas vezes por limite de uso e não auditou.
- **Sem assinatura de falha**; 8 achados; 16 de 16 arquivos lidos.
- **Conferência do Claude:** confirmados os achados 1 (o `StoredItem` tem `id` e não `mutationId`; a exclusão faz `splice` e grava, então depois dela não há item com o id), 2 (contradição entre "recusando se o destino for symlink" e o experimento, que trocou o symlink por arquivo comum), 3 (o worker só tem os comandos de `work_loop`: `transcribe`, `classify`, `detect_*`, `describe_screen`; nenhum de leitura ou escrita de arquivo) e a primeira metade do 4 (T2-0 ainda começa por "escolher o veículo"). A segunda metade do 4 (linha da seção 0 sobre a T5) **não procede**: a linha já traz a nota "na v2.2 foi dividida em T5a/T5b". Os achados 5 a 8 não foram conferidos um a um.

---

## Achados

### 1. A recuperação da T4 não cobre todas as mutações e o experimento não representa o store real

**EVIDÊNCIA:** O plano diz que cada lembrete, nota ou memória guardará `mutationId` e que a recuperação consultará o store por esse id (`docs/plans/openjarvis-voz-desktop-v2.md:184`). Mas o experimento usa um dicionário indexado diretamente pelo id (`docs/audits/experimentos-v2.4/t4_duas_fases.py:8-10, 21-26`), enquanto o `JsonStore` real persiste `{ items: T[] }` e cada item tem `id`, não `mutationId` (`src/backend/storage/jsonStore.ts:12-18, 34-63`). Além disso, a ferramenta pode excluir um lembrete removendo-o da lista antes de gravar (`src/backend/tools/mutatingTools.ts:429-433`); depois da exclusão, não há item no qual encontrar o `mutationId`.

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,99  
**AÇÃO RECOMENDADA:** Especificar como a recuperação reconhecerá criações, edições e exclusões. O marcador precisa ser gravado atomicamente junto à mudança, inclusive para exclusões; então refazer o experimento usando o formato e as operações reais do `JsonStore`.

### 2. A especificação de escrita da T2 contradiz o próprio resultado experimental

**EVIDÊNCIA:** A T2 diz que a escrita segura “recusa se o destino final for symlink” (`docs/plans/openjarvis-voz-desktop-v2.md:168`). Já o resultado registrado diz que ela preservou o alvo e **trocou o symlink por um arquivo comum** (`docs/audits/experimentos-v2.4/saida.txt:21-24`). O script executa `rename` sobre esse destino (`docs/audits/experimentos-v2.4/t2_openat_escrita.py:67-79`).

**GRAVIDADE:** alta  
**CONFIANÇA:** 1,0  
**AÇÃO RECOMENDADA:** Decidir e especificar o comportamento: recusar o symlink ou substituí-lo sem seguir o alvo. Ajustar o teste e o texto para que o critério de aceite corresponda ao comportamento escolhido.

### 3. O modo de escrita da T2 não tem contrato de IPC completo

**EVIDÊNCIA:** O plano diz que o helper Python abre, valida, lê e devolve bytes ao Node (`docs/plans/openjarvis-voz-desktop-v2.md:168`), mas também exige que o `openSafe()` tenha modo de escrita próprio. O worker atual comunica-se por mensagens e respostas no protocolo NDJSON (ver o loop em `scripts/worker/worker.py:1690-1735`); o plano não define comando de escrita, formato da requisição/resposta, falhas, limites ou confirmação da operação. A alternativa de deixar o `JsonStore` fora da política como exceção aparece na mesma seção, sem esclarecer se a exceção vale para leitura, escrita ou ambas.

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,96  
**AÇÃO RECOMENDADA:** Definir a API de leitura e escrita do helper e seu contrato de IPC, ou delimitar formalmente o `JsonStore` como exceção com escopo, risco e testes de bypass explícitos.

### 4. A v2.5 ainda apresenta como aberta uma escolha já registrada como tomada; uma correção anterior também só aparece na matriz

**EVIDÊNCIA:** A decisão 9 registra que o Rodrigo escolheu o helper Python (`docs/plans/openjarvis-voz-desktop-v2.md:272-273`), mas T2-0 ainda começa por “escolher o veículo” e lista novamente as opções (`:168`); a tabela de ordem também descreve T2-0 como escolha de veículo (`:136`). Separadamente, a matriz diz que T5 foi dividida em T5a/T5b (`:33`), e a ordem atual mostra essa divisão (`:138, 142`), mas a tabela histórica da seção 0 ainda afirma que “T5 passa a rodar junto de T1/T2” (`:14`). Assim, a divisão está no corpo normativo, mas a correção não foi incorporada em toda a narrativa.

**GRAVIDADE:** média  
**CONFIANÇA:** 1,0  
**AÇÃO RECOMENDADA:** Atualizar T2-0 para refletir que o veículo já foi escolhido e que a entrega pendente é o inventário; corrigir a linha histórica de T5 ou identificá-la claramente como descrição de uma versão anterior.

### 5. Os experimentos da T2 sustentam o protótipo, não a implementação que o plano propõe

**EVIDÊNCIA:** O próprio plano informa que os experimentos foram “fora do worker real” e sem concorrência (`docs/plans/openjarvis-voz-desktop-v2.md:114`). O script define seu próprio `open_safe()`, classificador e montagem dos caminhos (`docs/audits/experimentos-v2.4/t2_openat_escrita.py:16-37`); não chama o código real da T2, que ainda não existe. Apesar disso, a seção 0.5 diz que os experimentos “confirmaram o desenho da T2” (`docs/plans/openjarvis-voz-desktop-v2.md:102-110`), e a seção 3.2 afirma que o inode é “a única defesa” (`:172`).

**GRAVIDADE:** média  
**CONFIANÇA:** 0,98  
**AÇÃO RECOMENDADA:** Descrever os resultados como evidência do protótipo e das hipóteses testadas. Reservar conclusões sobre a implementação real para os testes da função efetiva e para a validação do worker no Mac.

### 6. A injeção indireta no prompt de geração continua sem barreira determinística

**EVIDÊNCIA:** O plano reconhece que memórias e conhecimento podem trazer instruções ao prompt de geração e propõe como mitigação rotular esses blocos como dados não confiáveis. Sem essa decisão, declara que o vetor é aceito sem barreira determinística (`docs/plans/openjarvis-voz-desktop-v2.md:161, 251`). No código atual, o bloco de memórias é acrescentado ao prompt de sistema (`src/backend/voice/sessionManager.ts:1058-1075`). O teste probabilístico proposto é explicitamente defesa adicional, não critério único (`docs/plans/openjarvis-voz-desktop-v2.md:160`).

**GRAVIDADE:** alta  
**CONFIANÇA:** 0,98  
**AÇÃO RECOMENDADA:** Resolver a mitigação ou registrar o risco como decisão pendente do usuário; não apresentar os testes estruturais de roteamento e ferramentas como cobertura desse caminho de geração.

### 7. A seção 0.5 exagera o que a recuperação T4 demonstrou

**EVIDÊNCIA:** O script testa quatro cenários em seu próprio armazenamento JSON (`docs/audits/experimentos-v2.4/t4_duas_fases.py:28-38`). Ele não usa o `JsonStore`, não testa falha parcial de escrita real nem executa uma mutação real do app. O plano corretamente registra limites gerais dos experimentos (`docs/plans/openjarvis-voz-desktop-v2.md:114`), mas a seção 0.5 chama o resultado de problema novo e a seção 3.4 já prescreve recuperação por id como caminho (`:111, 184`).

**GRAVIDADE:** média  
**CONFIANÇA:** 0,94  
**AÇÃO RECOMENDADA:** Tratar o resultado como prova de conceito de classificação dos cenários, não como validação do protocolo no app. Vincular a decisão de desenho a testes que usem mutações e stores reais, incluindo as operações destrutivas.

### 8. Algumas decisões tomadas estão refletidas no plano, mas ainda não no código

**EVIDÊNCIA:** A decisão 10 diz que visão deve vir desligada por padrão, mas registra que a mudança ainda não foi feita (`docs/plans/openjarvis-voz-desktop-v2.md:274-275`). O código segue com `cloudVision: true` por padrão (`src/backend/privacy.ts:121`). A seção T1 especifica o futuro padrão `false` e as atualizações associadas (`docs/plans/openjarvis-voz-desktop-v2.md:153`), então o plano reflete a decisão como trabalho pendente; não se deve confundir isso com estado implementado.

**GRAVIDADE:** média  
**CONFIANÇA:** 1,0  
**AÇÃO RECOMENDADA:** Manter explícita a distinção entre decisão tomada e alteração realizada, e incluir a mudança de padrão, cartão, README e teste de consistência como entregas verificáveis da T1.

## Três achados que mais bloqueiam a execução

1. **T4 não tem recuperação definida para exclusões**, e o experimento usa uma estrutura incompatível com o `JsonStore` real.
2. **T2 contradiz o comportamento observado para symlinks de destino** e ainda não especifica o contrato de IPC de escrita.
3. **A injeção indireta no prompt de geração continua sem barreira determinística**, sem decisão explícita de aceitar esse risco.

Verifiquei **16 de 16 arquivos pedidos**.
