# Laboratório Colab do Rodrigo AI

Esta pasta é uma camada opcional de laboratório. Ela não hospeda o aplicativo,
não participa da conversa em tempo real e não altera STT, LLM, TTS, memória,
SSE, barge-in ou os canais Gemini do runtime local.

## O que a v1 faz

O job `synthetic-baseline` valida o contrato de execução com dados sintéticos.
Ele pode rodar no Mac ou no Colab sem GPU, rede, chave ou gravação pessoal. O
resultado valida organização e proveniência; ele **não** mede qualidade da voz,
latência conversacional nem desempenho do hardware do Mac.

O Colab Pro é útil para futuras avaliações em lote, modelos de visão e
comparações de modelos. A sessão é efêmera, pode desconectar e não é uma GPU
garantida. Não há contratação, consumo automático de unidades ou fallback
automático para a nuvem.

## Fluxo manual e verificável

1. No repositório, valide o pacote permitido:

   ```bash
   python3 scripts/colab/validate-package.py colab
   python3 scripts/colab/test_contract.py
   ```

2. Obtenha a revisão de origem sem incluir `.env`, memória, pesquisa ou áudio:

   ```bash
   git rev-parse HEAD
   shasum -a 256 colab/jobs/synthetic-baseline/synthetic-baseline.ipynb
   ```

3. Abra manualmente `colab/jobs/synthetic-baseline/synthetic-baseline.ipynb`
   no Colab. O Colab/Drive exige rede e autorização do usuário; isso não é
   testado automaticamente pelo repositório.

4. Defina `RODRIGO_AI_COMMIT` com o hash real da etapa 2 e
   `RODRIGO_AI_JOB_SHA256` com o hash do notebook. Use um novo
   `RODRIGO_AI_RUN_ID` a cada tentativa, especialmente após desconexão.

5. Execute o notebook e copie manualmente o `result.json` para:

   ```text
   MyDrive/rodrigo-ai-colab/synthetic-baseline/<run-id>/result.json
   ```

   O job não monta o Drive nem faz upload automático. A cópia é uma ação
   explícita do usuário.

6. Traga manualmente o arquivo ao Mac e valide sem executar conteúdo:

   ```bash
   python3 scripts/colab/read-result.py /caminho/para/result.json
   ```

   JSON ausente, truncado ou com campos desconhecidos é inválido. Um resultado
   parcial nunca é reaproveitado como sucesso.

## Contrato de `result.json`

O schema v1 exige `schema_version`, `job`, `run_id`, `status`, `metrics`, `gpu`,
`duration_seconds`, `commit`, `source` e `created_at`. `source` contém o hash
SHA-256 do job, versões de dependências e indicador de árvore modificada.
Métricas são números finitos não negativos com nomes documentados pelo job.

O escritor local usa arquivo temporário e substituição atômica. O leitor não
resolve caminhos do JSON, não executa notebooks e não baixa dados.

## Privacidade e custo

Por padrão, não sobem para o Colab: gravações, documentos pessoais,
`docs/research/`, `memory/`, `media/`, `logs/`, `.env*`, tokens, certificados,
chaves ou dados de pacientes. A allowlist positiva está em
`colab/ALLOWLIST.md`; escapes de caminho e symlinks são recusados.

Gemini não é chamado por este job. O uso futuro de dados reais, TTS Kokoro ou
avaliações pesadas exigirá uma especificação própria com dados autorizados,
retenção, métricas, hardware e limite de custo antes de qualquer upload.

Antigravity permanece uma ferramenta operacional opcional para experimentos; não
é dependência do laboratório e não edita branches automaticamente.
