# Revisão independente — correções necessárias Fase 1
Coordenador, 2026-09-11. Não altera plano; concretiza A2/A3/A7.
Já verificado: 18 testes backend passam, build/typecheck passam; navegador produção em 4317 conecta, falha quando servidor para e recupera com Enter no botão; largura 320px sem overflow (scrollWidth=clientWidth=320).

1. scripts/dev.mjs usa parseInt e aceita 3000abc/3.5; validar string estrita e portas distintas antes de qualquer processo/socket. Vite deve receber apenas configuração validada.
2. Encerramento dev: shell:true+npx pode deixar Vite/netos vivos. Executar binários locais via process.execPath e caminhos locais (tsc/vite) sem shell; registrar shutdown antes de iniciar compilador e incluir todos os filhos; preservar código de falha em vez de sempre 0. Testar SIGTERM só no coordenador dev e checar ambas portas livres, além de falha de porta e interrupção durante compilação.
3. vite.config.ts: aplicar Host exato localhost/127.0.0.1 também no dev para TODAS rotas. Default Vite aceita outros IPs e subdomínios .localhost. Testar localhost.evil, evil.localhost e 192.0.2.1 com Host customizado; exigir 403. Registrar env/config HOST conforme README (se suportar localhost, proxy/backend precisam coincidir IPv4/IPv6).
4. src/frontend/main.ts: timeout é limpo antes de response.json; servidor que entrega headers mas trava corpo deixa carregando eterno. Manter timeout até finally após leitura/validação JSON. Mensagens de rede sempre em português, sem expor 'Failed to fetch'.
5. Tela: substituir textos de implementação (backend, TypeScript, loopback, interfaces tipadas, CDN etc.) por português simples orientado ao usuário. Exemplos: 'Conexão com o sistema', 'Tudo pronto neste computador', recursos futuros voz/conversas/agentes. Detalhes técnicos no README. Substituir 'Custo de Operação R$ 0,00' por 'Sem cobrança de API nesta fase', mantendo observação de energia/hardware. Não prometer custo futuro.
6. Completar README e relatório matriz A1–A8 com evidências honestas. Não afirmar observação pessoal de navegador: citar verificação independente do coordenador acima.
7. npm ci/build/typecheck/test e dev/start devem funcionar de projeto limpo e instruções env corretas; se .env.example recomendar arquivo .env, carregá-lo de verdade ou explicar export, sem prometer carregamento inexistente.

Faça correções agrupadas, apenas neste projeto. Não avance Fase 2. Execute verificações e reporte pendências reais.

## Evidência adicional: código de saída incorreto (ainda pendente)
Teste independente check-failure.mjs iniciou dev 4331/4332 e encerrou apenas seu backend. Ambos processos fecharam, mas dev retornou exitCode=0, ocultando a falha. Em cleanupAndExit definir process.exitCode=code (além de finalExitCode); o timer unref não garante process.exit quando os filhos acabam. Testar falha inesperada do backend e exigir saída não zero. Já confirmei que Host inválido dá 403 em ambas portas para 127.0.0.1 e localhost, e que ambas portas ficam livres após SIGTERM. Não precisa repetir essas investigações sem mudança relevante.
