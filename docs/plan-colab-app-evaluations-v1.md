# Plano de implementação — Avaliações econômicas dos apps via Colab

## Objetivo

Ampliar o laboratório Colab do Rodrigo AI para avaliar os cinco aplicativos mais usados pelo proprietário, sem colocar o Colab no caminho de produção, sem enviar dados pessoais por padrão e sem consumir APIs pagas automaticamente.

Aplicativos cobertos:

1. Scheduler/Sheduler
2. Controle Finanças
3. Temperament App v2
4. Audio Transcriber
5. PsicoApp

## Regras obrigatórias

- O runtime de produção continua local e não depende do Colab.
- O padrão é CPU, dados sintéticos e rede desativada.
- Nenhuma chave de API, `.env`, memória, áudio pessoal, documento clínico ou transação real entra no pacote.
- Qualquer uso de dado real exige uma especificação separada, anonimização e autorização explícita.
- Cada job deve produzir `result.json` compatível com o contrato v1 e registrar commit, hash do job, dependências e métricas.
- Jobs devem ser determinísticos quando possível e aceitar um `run_id` novo a cada execução.
- Nenhum job pode alterar configurações de produção, modelos ou canais de voz.
- O uso de GPU do Colab é opcional e restrito ao benchmark de transcrição, após uma execução CPU de referência.

## Ordem de execução

### Fase A — Infraestrutura comum

**Objetivo:** permitir que vários jobs compartilhem o contrato, geração de casos sintéticos, comparação de resultados e limites de custo.

**Entregas:**

- extensão mínima do contrato para identificar `app`, `dataset_version`, `seed` e unidades das métricas;
- utilitário comum para gerar dados sintéticos determinísticos;
- comandos locais para validar pacote e resultado;
- documentação de custo estimado, tempo máximo e uso de GPU por job;
- tabela de métricas permitidas por job.

**Critérios de aceite:**

- um resultado antigo do `synthetic-baseline` continua válido;
- um resultado com app e dataset sintéticos é validado;
- campos desconhecidos, caminhos proibidos e métricas inválidas continuam sendo rejeitados;
- nenhuma dependência paga ou chamada de rede é adicionada.

### Fase B — Scheduler/Sheduler reliability

**Objetivo:** detectar duplicações, perdas e falhas de retry em agendamentos.

**Cenários sintéticos:** criação, atualização, cancelamento, webhook duplicado, timeout, retry, reinício, fuso horário e concorrência.

**Métricas:** taxa de operações corretas, duplicatas, eventos perdidos, retries até sucesso, latência p50/p95 e violações de idempotência.

**Critérios de aceite:**

- casos determinísticos reproduzem os mesmos resultados para a mesma seed;
- duplicatas e eventos perdidos são identificados;
- nenhum teste exige calendário, WhatsApp, e-mail, rede ou credencial real;
- falhas são reportadas sem mascarar o erro como sucesso.

### Fase C — Controle Finanças validation

**Objetivo:** reduzir erros financeiros e reservar LLM somente para transações ambíguas.

**Cenários sintéticos:** entradas e saídas, parcelas, transferências internas, duplicatas, categorias, datas, valores negativos, totais mensais e anomalias.

**Métricas:** exatidão dos totais, taxa de duplicatas detectadas, precisão de categorização, itens ambíguos, confiança e divergência entre saldo esperado e calculado.

**Critérios de aceite:**

- totais e saldos são validados por regras determinísticas;
- transações ambíguas ficam separadas para revisão;
- o job não usa dados bancários ou arquivos pessoais;
- um limite de erro definido interrompe a aprovação do resultado.

### Fase D — Temperament App v2 regression

**Objetivo:** garantir que mudanças no questionário ou na pontuação não alterem indevidamente os perfis.

**Cenários sintéticos:** perfis extremos, respostas neutras, respostas conflitantes, dados incompletos e casos de fronteira.

**Métricas:** estabilidade da pontuação, consistência por dimensão, casos alterados entre commits, completude da explicação e taxa de casos inconclusivos.

**Critérios de aceite:**

- cada caso sintético tem resultado esperado versionado;
- mudanças de resultado são listadas com commit anterior e atual;
- dados incompletos não recebem diagnóstico indevido;
- o job não faz afirmações clínicas além do escopo do aplicativo.

### Fase E — Audio Transcriber benchmark

**Objetivo:** escolher a melhor opção local de transcrição antes de pagar por uma API.

**Ordem de comparação:** modelo local disponível no Mac, execução CPU no Colab e, somente se necessário, execução GPU no Colab.

**Dados:** primeiro áudio sintético e corpus público autorizado; áudio pessoal fica fora do padrão.

**Métricas:** WER/CER quando houver referência, latência, tempo por minuto de áudio, uso de memória, tamanho do modelo e disponibilidade de GPU.

**Critérios de aceite:**

- cada execução registra modelo, versão, hardware e dataset;
- CPU é a referência de custo zero;
- GPU não é requisito do job;
- o relatório mostra claramente o trade-off entre qualidade, velocidade e custo;
- nenhum áudio é enviado automaticamente para o Drive ou para uma API.

### Fase F — PsicoApp safety and consistency

**Objetivo:** testar consistência de processamento e barreiras de segurança usando somente casos sintéticos ou públicos autorizados.

**Cenários sintéticos:** relatos incompletos, linguagem ambígua, sinais de risco simulados, ausência de risco, pedidos fora do escopo e tentativas de obter diagnóstico.

**Métricas:** identificação de sinais de risco, falsos negativos, falsos positivos, completude da coleta, recusa de diagnóstico indevido e consistência entre execuções.

**Critérios de aceite:**

- o job não usa prontuários, nomes, contatos ou dados de pacientes;
- sinais de risco nunca são silenciosamente descartados;
- resultados inconclusivos são encaminhados para revisão humana;
- a avaliação não é apresentada como validação clínica;
- qualquer uso de modelo pago fica desligado por padrão e sujeito a limite de orçamento.

## Revisão e promoção entre fases

Para cada fase:

1. escrever uma especificação objetiva do job;
2. implementar o job e seus dados sintéticos;
3. executar validação de pacote, testes unitários e o job localmente;
4. comparar o resultado com os critérios de aceite;
5. corrigir falhas antes de avançar;
6. registrar auditoria, commit e resultado;
7. somente então iniciar a próxima fase.

A aprovação exige `npm test`, `npm run typecheck`, `npm run build`, testes Python do laboratório e validação específica do job. Um job que falhar por ausência de Colab deve ser marcado como não executado remotamente, sem ser tratado como sucesso.

## Resultado final esperado

O repositório terá jobs reprodutíveis para os cinco aplicativos, com métricas comparáveis, dados sintéticos e controle explícito de custo. O Rodrigo AI poderá usar esses resultados para escolher modelos e prioridades sem depender de APIs pagas ou de execução contínua no Colab.
