# Plano — Laboratório Colab opcional do Rodrigo AI (v1)

## Objetivo

Criar uma camada opcional de jobs reproduzíveis para usar o Colab Pro em
benchmarks e avaliações em lote, sem colocar o Colab no caminho da conversa ao
vivo e sem enviar dados pessoais por padrão.

## Escopo da v1

- documentação do fluxo e das fronteiras de segurança em `colab/README.md`;
- allowlist de entradas e verificação automática em `colab/ALLOWLIST.md`;
- biblioteca Python pequena para contrato de execução e `result.json`;
- leitor local somente leitura para validar resultados;
- um job sintético de benchmark, sem áudio pessoal, sem `docs/research/`, sem
  memória e sem chaves;
- teste local do contrato e da allowlist.

Jobs de baseline com gravações reais, Kokoro em GPU e avaliações pesadas ficam
documentados como extensões futuras, mas não serão ativados nem receberão dados
na v1.

O job v1 aceita somente arquivos sintéticos criados pelo próprio job dentro de
uma raiz de entrada explícita. Não há upload automático nem montagem automática
do Drive: o fluxo remoto é uma cópia manual opt-in de um pacote validado.

## Contrato

Cada execução usa `rodrigo-ai-colab/<job>/<run-id>/` no Drive e produz:

```json
{
  "schema_version": 1,
  "job": "synthetic-baseline",
  "run_id": "...",
  "status": "success|failed",
  "metrics": {},
  "gpu": {"name": null, "available": false},
  "duration_seconds": 0.0,
  "commit": "...",
  "created_at": "..."
}
```

O leitor local rejeita schema desconhecido, status inválido, métricas não
objetivas, duração negativa, commit ausente ou caminhos proibidos. Métricas são
um mapa de nomes conhecidos para números finitos não negativos e unidades
documentadas; campos desconhecidos são rejeitados.

O pacote pode conter somente `colab/jobs/`, `colab/lib/` e arquivos sintéticos
gerados pelo job. A verificação resolve caminhos reais contra a raiz permitida,
rejeita `..`, caminhos absolutos fora da raiz e links simbólicos que escapem da
raiz. `job` e `run_id` aceitam apenas identificadores seguros (`[A-Za-z0-9._-]`)
e nunca são usados como segmentos livres de caminho.

O `result.json` é escrito primeiro como temporário no mesmo diretório e então
substituído atomicamente. JSON ausente, truncado ou inconsistente significa
resultado inválido; nunca é tratado como sucesso nem reaproveitado de outra
execução. Uma repetição após desconexão precisa de novo `run_id`.

## Segurança e custo

- nenhum segredo fica no notebook, no job ou no resultado;
- entradas pessoais e corpus privado ficam fora do Colab por padrão;
- Gemini não é chamado pelo laboratório automaticamente;
- jobs são opt-in e não alteram `TTS_ENGINE`, modelos ou canais de nuvem;
- o benchmark inicial é sintético e não consome GPU obrigatoriamente;
- execução local sem GPU e sem rede é o padrão;
- o Colab é considerado ambiente efêmero e sujeito a desconexão;
- o runtime local continua sendo a autoridade para voz, sessão, memória,
  segurança, SSE e barge-in.

## Critérios de aceite

1. `colab/` contém README, allowlist, biblioteca e um job de exemplo.
2. A validação bloqueia `docs/research`, `memory`, `media`, `logs`, `.env`,
   chaves e caminhos fora da árvore permitida.
3. O README contém um roteiro executável para: preparar um pacote permitido,
   abrir o notebook no Colab, executar, salvar em `MyDrive/rodrigo-ai-colab/`,
   copiar manualmente o resultado ao Mac e validá-lo localmente. A execução
   remota será declarada como não testada se o ambiente Colab não estiver
   disponível.
4. O job de exemplo pode ser executado sem GPU, rede, chave ou dado pessoal.
5. O leitor local valida um resultado correto e rejeita pelo menos seis casos
   inválidos, incluindo truncamento, métrica não finita, caminho proibido,
   `..`, symlink de escape e campo desconhecido.
6. O resultado registra commit, hash do job, versão de dependências e se a
   árvore de origem estava modificada.
7. `npm test`, `npm run typecheck` e `npm run build` continuam passando.
8. Nenhuma configuração de produção, modelo ou canal de nuvem é alterada.

## Fora do escopo

- hospedar o aplicativo ou a conversa em tempo real no Colab;
- upload automático de gravações reais;
- troca do Gemini, MLX, Kokoro ou `say` no runtime;
- push, merge, deploy ou alteração de decisões D1–D6.
