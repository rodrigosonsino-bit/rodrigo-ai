# Fase A — infraestrutura comum

Implementação local concluída em 2026-10-14 sem alterar o runtime de produção.

O contrato v1 continua aceitando o resultado antigo de `synthetic-baseline`.
Resultados dos jobs de avaliação recebem `app`, `dataset_version`, `seed` e
`metric_units`; os quatro campos são obrigatórios juntos, com seed limitada a
`0..2^32-1` e unidades para cada métrica. Campos desconhecidos, booleanos em
métricas, valores não finitos e limites fora do registro são rejeitados.

O registro em `colab/lib/registry.py` define os cinco jobs, apps sintéticos,
versão `synthetic-v1`, métricas, unidades, limite CPU e GPU desativada. O
gerador usa `random.Random(seed)` e é repetível. O runner recusa `run_id`
reutilizado, calcula hash canônico de `colab/*.py` e do runner, registra commit,
dependências e árvore modificada, e escreve o resultado atomicamente.

O comparador valida ambos os resultados antes de calcular deltas e exige job,
app, dataset, seed e unidades compatíveis. Os avaliadores dos cinco jobs são
oráculos sintéticos de referência; não afirmam integração com os aplicativos
proprietários, que não estão presentes neste checkout.

Validação executada:

- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_a.py` passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_contract.py` passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/validate-package.py colab` passou;
- os cinco jobs rodaram em CPU local com seed 7 e foram aceitos pelo leitor;
- `npm run typecheck` passou;
- `npm run build` passou.

`npm test` permanece dependente das restrições do ambiente: a execução anterior
falhou em testes de integração que tentam abrir sockets e recebem `EPERM`, além
de falhas legadas de integração. Nenhum resultado parcial foi tratado como
aprovação.
