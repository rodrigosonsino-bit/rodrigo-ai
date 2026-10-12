# Evidências — Fase 2: notebooks (registrado antes de qualquer deleção)

Data: 2026-10-12 07:09 PT · Ferramenta: `notebooklm source list --json` e `source fulltext`.

## 1. Possíveis duplicados "Psicoterapeuta Rodrigo Sonsino - psicanálise e virtologia"

| Notebook | Fontes | Fonte | id da fonte | Criada (UTC) | Caracteres | sha256 do fulltext |
|---|---|---|---|---|---|---|
| 5cddc991-4305-4b94-ab8a-cfa0ac13bfd9 | 1 | Business Context (markdown, ready) | 594233f8 | 2026-06-18 22:13:05 | 1.086 | 4f8de3a6… |
| 082c057a-21c2-4b05-bb44-3a29cd09ea4a | 1 | Business Context (markdown, ready) | bf64e48a | 2026-06-18 22:13:20 | 1.070 | 2671708b… |

As duas listas de fontes têm o mesmo título e a mesma quantidade, mas os **conteúdos são diferentes**:
- 5cddc991 escreve os dias da semana em inglês ("Monday"); 082c057a, em português ("Segunda").
- Os campos vazios aparecem como "Not specified/Not available" num e "Not provided" no outro.
- O link do Instagram está formatado de jeito diferente.

**Decisão: NÃO deletar.** A condição "listas idênticas" não foi atendida, porque o conteúdo não é idêntico. A consolidação fica para o Rodrigo decidir.

## 2. Notebooks sem título

| Notebook | Título | Fontes | Decisão |
|---|---|---|---|
| deb98c1c-69d0-4a00-b29a-63c360ebd210 | (vazio) | 0 | deletar (vazio) |
| d6421dc7-dfdb-422d-878b-3a752bcb71cb | (vazio) | 0 | deletar (vazio) |
| 91c4cf62-0ff1-4aa2-84a8-1886231c1e04 | (vazio) | 0 | deletar (vazio) |

Deleção autorizada pelo Rodrigo sob essas condições (notebook vazio).

## 3. Execução (2026-10-12 07:32 PT)

- Antes de cada deleção, a contagem de fontes foi conferida de novo (0). Foram deletados deb98c1c, d6421dc7 e 91c4cf62. Depois disso, `notebooklm list` não lista mais nenhum dos três.
- Psicoterapeuta 5cddc991 e 082c057a: **mantidos**, porque o conteúdo difere.
- Novo notebook: `d7378de8-3f8f-4fec-94ff-c6d96f216e4a`, "ENGENHARIA DE SOFTWARE (backend e frontend)", com 17 fontes por URL. Durante a montagem, removi 2 fontes que eu mesmo tinha adicionado por engano: um arXiv errado (2105.12854, sobre teoria dos números) e uma URL da IEEE que deu erro ao ingerir.
- Exportação de psicanálise para `docs/research/`: 4d6ff1c2 (42), 4b9a4517 (47), 64beea89 (6), 09ff14d7 (27), 5cddc991 (1) e 082c057a (1). Total de 124 fontes, sem erros.
