# Allowlist do laboratório Colab

A v1 permite somente um pacote formado por `colab/` e, quando necessário para
um experimento futuro explicitamente aprovado, `input/`. O job sintético atual
não precisa de `input/`: ele gera seus próprios dados determinísticos.

São recusados, inclusive por symlink ou por caminho com `..`:

- `docs/research/`, `memory/`, `media/` e `logs/`;
- `.env*`, chaves, certificados, tokens e arquivos pessoais;
- caminhos absolutos fora da raiz do pacote;
- qualquer arquivo que não seja regular;
- diretórios de topo que não sejam `colab/` ou `input/`.

O verificador resolve cada componente do caminho e recusa symlinks. A allowlist
é positiva: bloquear apenas nomes conhecidos não é suficiente.

Validação local:

```bash
python3 scripts/colab/validate-package.py colab
```

O resultado impresso é apenas uma lista de caminhos permitidos; nenhum arquivo
é executado e nenhum caminho vindo de `result.json` é seguido.
