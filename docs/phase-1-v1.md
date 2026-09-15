# Rodrigo AI — Fase 1, especificação v1
Data: 2026-09-11. Escopo autorizado: somente fundação técnica.

## Objetivo
Entregar Rodrigo AI v0.0.1: aplicativo local TypeScript/Node.js com interface web em português, comunicação real com backend e fronteiras modulares para futura voz, orquestrador, especialistas e ferramentas. Nesta fase nenhuma inferência, captura de microfone ou serviço pago é necessária. Usuário prioriza menor custo operacional sem perda de qualidade silenciosa.

## Arquitetura e limites
Projeto independente nesta pasta. Node.js + TypeScript; frontend leve (HTML/CSS/TypeScript com Vite ou equivalente), backend HTTP pequeno; evitar frameworks e dependências desnecessários. Um comando de desenvolvimento deve iniciar ambos, escutando exclusivamente em loopback. Build e start devem servir aplicativo e API na mesma origem. Host permitido apenas localhost/127.0.0.1; sem CORS permissivo, rejeitar hosts estranhos. API apenas leitura nesta fase, sem operações externas. Não armazenar conversas ou dados pessoais. Nenhum segredo no frontend ou logs.
Configuração via ambiente validada, com porta padrão e erros claros; .env.example sem credenciais, .gitignore para .env*, node_modules e build (exceto exemplo). Nenhuma chave obrigatória. Registrar módulos/interface para agentes, ferramentas e provedores de voz/IA, sem escolher provedor nem fingir implementação de IA. Registro vazio e recursos indisponíveis honestamente indicados. Sem instalar modelos, contratar serviço, alterar configurações globais, publicar ou avançar fases.

## Critérios de aceite e evidência
A1. Instalação reproduzível com npm e lockfile; README PT-BR com requisitos reais, instalar, desenvolver, build, start e testar.
A2. npm run dev inicia frontend/backend; frontend consulta GET /api/health de verdade; interface exibe conectado, carregando e falha recuperável (botão tentar novamente). API retorna JSON mínimo com status e versão 0.0.1, sem ambiente/segredos.
A3. UI legível em desktop e celular, navegação por teclado, foco visível e status acessível; título Rodrigo AI, fase atual e indicação de que voz/agentes ainda não estão disponíveis. Sem chat ou microfone falsamente funcional.
A4. npm run build, npm run typecheck e npm test passam; npm start serve build e API. Verificar navegador e fluxo de saúde; registrar observação real e limitações.
A5. Código separado frontend/backend/shared e pontos de extensão para voz/agentes/ferramentas; interfaces tipadas simples, sem implementação antecipada de fases 2–4.
A6. Operação sem chave/API externa, sem conexão de aplicação a terceiros, sem fontes/CDN externos; nenhuma cobrança por inferência na fase 1. Não prometer qualidade ou latência futura antes de medir. Recursos locais consomem hardware/energia; pacotes exigem rede na instalação.
A7. Testes relevantes: saúde/versão e resposta sem segredos, configuração inválida, 404 API (não retornar HTML), rejeição de Host externo. Validar falha e recuperação de conexão UI por teste ou inspeção controlada. Documentar portas/encerramento limpo; servidor não exposto à rede.
A8. Relatório com arquivos principais, comandos e resultados, matriz A1–A7 e pendências reais. Coordenador revisa independentemente e devolve falhas ao executor; só concluir depois de evidências.

## Fatos e hipóteses
Verificado: macOS, Node/npm e agy instalados; pasta inicial vazia. agy requer execução fora do sandbox para sockets/logs. Versões Node/npm e dependências serão confirmadas antes de instalar. A existência de login funcional do CLI ainda não foi comprovada. Nenhuma escolha de provedor de voz ou qualidade dos modelos foi validada. Fases posteriores exigirão especificações próprias e discussão com o usuário se custo afetar qualidade.
