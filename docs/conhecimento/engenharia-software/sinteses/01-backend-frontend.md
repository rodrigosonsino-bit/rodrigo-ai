# Engenharia de software: backend e frontend

> Síntese gerada em 2026-10-12 a partir **somente** do notebook `d7378de8-3f8f-4fec-94ff-c6d96f216e4a` (NotebookLM, resposta com citações). As citações apontam para fontes reais do notebook; os markdowns locais equivalentes estão em `docs/research/` (gitignored). Revisão humana pendente.

**Pergunta feita:** Em português, faça uma síntese técnica e objetiva, apenas com base nas fontes, destes temas centrais: (1) princípios de backend (12-factor, semântica HTTP, padrões de nuvem); (2) segurança (OWASP Top 10 e REST); (3) confiabilidade e entrega (SRE, métricas DORA, pirâmide de testes); (4) frontend (Thinking in React, Web Vitals, performance, acessibilidade WCAG 2.2); (5) microsserviços: benefícios e riscos. Cite as fontes em cada afirmação. Se algo não estiver nas fontes, diga explicitamente.

### 1. Princípios de Backend

#### **The Twelve-Factor App**
A metodologia **Twelve-Factor App** estabelece 12 princípios fundamentais para a construção de aplicações entregues como serviço (SaaS / web apps), focando em portabilidade, automação e escalabilidade na nuvem [NB:d7378de8 · The Twelve-Factor App]:
1. **Codebase**: Um único repositório rastreado em controle de versão serve para múltiplos deploys [NB:d7378de8 · The Twelve-Factor App].
2. **Dependencies**: As dependências devem ser declaradas e isoladas de forma estrita e explícita [NB:d7378de8 · The Twelve-Factor App].
3. **Config**: Armazenar as configurações da aplicação estritamente no ambiente de execução (variáveis de ambiente) [NB:d7378de8 · The Twelve-Factor App].
4. **Backing services**: Tratar serviços de apoio (como bancos de dados, filas de mensagem e sistemas de cache) como recursos anexados [NB:d7378de8 · The Twelve-Factor App].
5. **Build, release, run**: Separar com rigor as etapas de compilação (*build*), lançamento (*release*) e execução (*run*) [NB:d7378de8 · The Twelve-Factor App].
6. **Processes**: Executar a aplicação como um ou mais processos *stateless* e sem compartilhamento de memória [NB:d7378de8 · The Twelve-Factor App].
7. **Port binding**: Exportar serviços e expor funcionalidades diretamente via ligação de portas (*port binding*) [NB:d7378de8 · The Twelve-Factor App].
8. **Concurrency**: Escalar horizontalmente a aplicação através do modelo de processos [NB:d7378de8 · The Twelve-Factor App].
9. **Disposability**: Maximizar a robustez com inicialização rápida e encerramento gracioso (*graceful shutdown*) [NB:d7378de8 · The Twelve-Factor App].
10. **Dev/prod parity**: Manter os ambientes de desenvolvimento, testes e produção o mais parecidos possível [NB:d7378de8 · The Twelve-Factor App].
11. **Logs**: Tratar os registros de log como fluxos contínuos de eventos (*event streams*) [NB:d7378de8 · The Twelve-Factor App].
12. **Admin processes**: Executar tarefas de administração ou manutenção como processos pontuais (*one-off processes*) [NB:d7378de8 · The Twelve-Factor App].

#### **Semântica HTTP (RFC 9110)**
O protocolo **HTTP** é um protocolo sem estado (*stateless*), focado na camada de aplicação, baseado no modelo de requisição e resposta [NB:d7378de8 · RFC 9110: HTTP Semantics]. As regras semânticas centrais englobam:
* **Métodos e Propriedades**: Os métodos indicam a finalidade da requisição [NB:d7378de8 · RFC 9110: HTTP Semantics]. São classificados em **seguros** (*safe*, como GET, HEAD, OPTIONS e TRACE, que não alteram o estado do recurso) [NB:d7378de8 · RFC 9110: HTTP Semantics] e **idempotentes** (*idempotent*, como GET, HEAD, OPTIONS, TRACE, PUT e DELETE, nos quais múltiplas requisições idênticas produzem o mesmo efeito que uma única) [NB:d7378de8 · RFC 9110: HTTP Semantics]. Métodos como POST não são seguros nem idempotentes [NB:d7378de8 · RFC 9110: HTTP Semantics].
* **Classes de Códigos de Status**: As respostas dividem-se em 1xx (Informacional), 2xx (Sucesso), 3xx (Redirecionamento), 4xx (Erro do Cliente) e 5xx (Erro do Servidor) [NB:d7378de8 · REST Security - OWASP Cheat Sheet Series; NB:d7378de8 · RFC 9110: HTTP Semantics].
* **Requisições Condicionais e Concorrência**: Utilização de validadores (como `ETag` e `Last-Modified`) e cabeçalhos condicionais (`If-Match`, `If-None-Match`, `If-Modified-Since`) para revalidação eficiente de cache e prevenção do problema de atualizações perdidas (*lost update*) em métodos de alteração de estado [NB:d7378de8 · RFC 9110: HTTP Semantics].

#### **Padrões de Nuvem (Cloud Design Patterns)**
Projetados para lidar com as falácias da computação distribuída (como rede não confiável, latência diferente de zero e largura de banda finita) [NB:d7378de8 · Cloud Design Patterns - Azure Architecture Center | Microsoft Learn], os padrões de nuvem organizam-se em diversas categorias [NB:d7378de8 · Cloud Design Patterns - Azure Architecture Center | Microsoft Learn]:
* **Resiliência e Confiabilidade**: **Retry** (repetição em falhas transitórias), **Circuit Breaker** (interrupção de chamadas a serviços indisponíveis), **Bulkhead** (isolamento de recursos em pools), **Rate Limiting** e **Throttling** [NB:d7378de8 · Cloud Design Patterns - Azure Architecture Center | Microsoft Learn].
* **Desempenho e Gerenciamento de Dados**: **Cache-Aside** (carregamento sob demanda em cache), **CQRS** (separação de interfaces de leitura e escrita), **Materialized View**, **Sharding** (particionamento horizontal de dados), **Queue-Based Load Leveling** e **Competing Consumers** [NB:d7378de8 · Cloud Design Patterns - Azure Architecture Center | Microsoft Learn].
* **Roteamento e Arquitetura**: **Backends for Frontends (BFF)** (backends dedicados por interface), **Gateway Routing**, **Gateway Aggregation**, **Gateway Offloading**, **Sidecar** e **Strangler Fig** (migração incremental de sistemas legados) [NB:d7378de8 · Cloud Design Patterns - Azure Architecture Center | Microsoft Learn].
* **Consistência Distribuída**: **Saga** (gerenciamento de consistência entre microsserviços), **Compensating Transaction** e **Event Sourcing** [NB:d7378de8 · Cloud Design Patterns - Azure Architecture Center | Microsoft Learn].
* **Composição**: É comum combinar padrões para cobrir lacunas operacionais (por exemplo, parear *Retry* com *Circuit Breaker* ou *Saga* com *Compensating Transaction*) [NB:d7378de8 · Cloud Design Patterns - Azure Architecture Center | Microsoft Learn].

---

### 2. Segurança em Aplicações Web e REST

#### **OWASP Top 10 (2025)**
Representa o consenso comunitário sobre os riscos de segurança mais críticos em aplicações web [NB:d7378de8 · OWASP Top 10:2025]:
1. **A01:2025 - Broken Access Control**: Falhas na restrição de acesso a usuários não autorizados [NB:d7378de8 · OWASP Top 10:2025].
2. **A02:2025 - Security Misconfiguration**: Configurações incorretas ou inseguras de sistemas e servidores [NB:d7378de8 · OWASP Top 10:2025].
3. **A03:2025 - Software Supply Chain Failures**: Vulnerabilidades oriundas de dependências e componentes de terceiros [NB:d7378de8 · OWASP Top 10:2025].
4. **A04:2025 - Cryptographic Failures**: Falhas na proteção de dados sensíveis em trânsito ou repouso [NB:d7378de8 · OWASP Top 10:2025].
5. **A05:2025 - Injection**: Injeção de código ou comandos não sanitizados (ex: SQL Injection) [NB:d7378de8 · OWASP Top 10:2025].
6. **A06:2025 - Insecure Design**: Deficiências nos padrões e na arquitetura de segurança [NB:d7378de8 · OWASP Top 10:2025].
7. **A07:2025 - Authentication Failures**: Erros na confirmação da identidade do usuário [NB:d7378de8 · OWASP Top 10:2025].
8. **A08:2025 - Software or Data Integrity Failures**: Falhas na verificação de integridade de atualizações e dados [NB:d7378de8 · OWASP Top 10:2025].
9. **A09:2025 - Security Logging and Alerting Failures**: Deficiência na auditoria e detecção de ataques [NB:d7378de8 · OWASP Top 10:2025].
10. **A10:2025 - Mishandling of Exceptional Conditions**: Tratamento inadequado de erros e exceções [NB:d7378de8 · OWASP Top 10:2025].

#### **Boas Práticas de Segurança em APIs REST**
* **Tráfego Criptografado**: O uso de **HTTPS** é obrigatório para proteger credenciais e garantir integridade em trânsito [NB:d7378de8 · REST Security - OWASP Cheat Sheet Series].
* **Controle de Acesso e Tokens**: O controle de acesso deve ser validado localmente em cada endpoint para minimizar latência [NB:d7378de8 · REST Security - OWASP Cheat Sheet Series]. A autenticação deve ser centralizada em um Provedor de Identidade (IdP) emitindo tokens criptograficamente assinados, como **JWT (JSON Web Tokens)** [NB:d7378de8 · REST Security - OWASP Cheat Sheet Series].
* **Chaves de API e Taxa de Limite**: Aplicação de **API Keys** e suporte a limites de taxa (*Rate Limiting*), retornando o código HTTP `429 Too Many Requests` quando excedido [NB:d7378de8 · REST Security - OWASP Cheat Sheet Series].
* **Validação de Entrada e Content-Type**: Não confiar em parâmetros de entrada; restringir formatos, limites de tamanho (status `413 Payload Too Large`) e validar cabeçalhos `Content-Type` (rejeitando não suportados com `415 Unsupported Media Type`) e `Accept` (retornando `406 Not Acceptable`) [NB:d7378de8 · REST Security - OWASP Cheat Sheet Series].
* **Restrição de Métodos e Sequenciamento**: Impor uma lista permitida (*allowlist*) de métodos HTTP por endpoint (retornando `405 Method Not Allowed` caso contrário) [NB:d7378de8 · REST Security - OWASP Cheat Sheet Series] e validar rigorosamente o estado do fluxo de trabalho (*workflow state*) no backend para impedir execuções fora de ordem [NB:d7378de8 · REST Security - OWASP Cheat Sheet Series].
* **Prevenção de Vazamentos**: Credenciais e chaves jamais devem constar na URL (query params) [NB:d7378de8 · REST Security - OWASP Cheat Sheet Series]. Mensagens de erro devem ser genéricas, evitando a exposição de detalhes técnicos ou *stack traces* internos [NB:d7378de8 · REST Security - OWASP Cheat Sheet Series].

---

### 3. Confiabilidade e Entrega de Software

#### **Google SRE (Site Reliability Engineering)**
O **Site Reliability Engineering (SRE)** aplica disciplinas de engenharia de software aos problemas de infraestrutura e operações em escala [NB:d7378de8 · Google SRE - Site reliability engineering book Google index]:
* **Princípios**: Foco na aceitação consciente do risco (*Embracing Risk*), definição de Objetivos de Nível de Serviço (**SLOs** - *Service Level Objectives*), eliminação contínua de trabalho braçal/repetitivo (*Toil*), automação, monitoramento e simplicidade [NB:d7378de8 · Google SRE - Site reliability engineering book Google index].
* **Práticas**: Sistemas práticos de alertas, escalas *on-call*, gestão de incidentes, cultura de *postmortem* sem culpabilização (*blameless postmortem*), engenharia de suporte contra falhas em cascata e tratamento de sobrecarga [NB:d7378de8 · Google SRE - Site reliability engineering book Google index].

#### **Métricas DORA**
O modelo DORA mensura o desempenho da entrega de software com base em **cinco métricas centrais**, divididas em duas dimensões [NB:d7378de8 · DORA | DORA’s software delivery performance metrics]:
* **Vazão (*Throughput*)**:
  1. *Change lead time*: Tempo decorrido desde o *commit* no controle de versão até a implantação em produção [NB:d7378de8 · DORA | DORA’s software delivery performance metrics].
  2. *Deployment frequency*: Frequência de implantações em produção [NB:d7378de8 · DORA | DORA’s software delivery performance metrics].
  3. *Failed deployment recovery time*: Tempo necessário para se recuperar de uma falha de implantação [NB:d7378de8 · DORA | DORA’s software delivery performance metrics].
* **Instabilidade (*Instability*)**:
  4. *Change fail rate*: Percentual de implantações que causam falhas imediatas exigindo intervenção (como *rollback* ou *hotfix*) [NB:d7378de8 · DORA | DORA’s software delivery performance metrics].
  5. *Deployment rework rate*: Proporção de implantações não planejadas decorrentes de incidentes em produção [NB:d7378de8 · DORA | DORA’s software delivery performance metrics].
* **Insight**: Velocidade e estabilidade não são alvos opostos; equipes de alta performance se destacam positivamente em ambas as dimensões [NB:d7378de8 · DORA | DORA’s software delivery performance metrics].

#### **Pirâmide de Testes (*The Practical Test Pyramid*)**
Metáfora para o agrupamento de testes automatizados por granularidade e proporção recomendada [NB:d7378de8 · The Practical Test Pyramid]:
* **Camadas**:
  1. **Testes Unitários**: Base da pirâmide. Testes pequenos, rápidos e isolados que cobrem regras de negócio e caminhos de código [NB:d7378de8 · The Practical Test Pyramid]. Devem testar comportamentos observáveis em vez da estrutura interna do código [NB:d7378de8 · The Practical Test Pyramid], seguindo o padrão *Arrange, Act, Assert* (ou *Given, When, Then*) [NB:d7378de8 · The Practical Test Pyramid].
  2. **Testes de Integração e Contrato**: Camada intermediária. Testam a integração com limites externos (bancos de dados, sistema de arquivos ou APIs de terceiros) [NB:d7378de8 · The Practical Test Pyramid]. O uso de **Testes de Contrato Guiados pelo Consumidor (CDC)**, com ferramentas como o *Pact*, permite validar contratos de API entre equipes sem necessitar de testes de ponta a ponta pesados [NB:d7378de8 · The Practical Test Pyramid].
  3. **Testes de UI / End-to-End (E2E)**: Topo da pirâmide. Devem existir em quantidade mínima por serem muito lentos, frágeis e caros de manter [NB:d7378de8 · The Practical Test Pyramid].
* **Regra de Ouro**: Empurrar a lógica de teste para a camada mais baixa possível na pirâmide para garantir *feedback* rápido no pipeline de CI/CD e evitar duplicações desnecessárias [NB:d7378de8 · The Practical Test Pyramid].

---

### 4. Frontend

#### **Thinking in React**
Processo mental estruturado em **cinco etapas** para construir UIs reativas [NB:d7378de8 · Thinking in React – React]:
1. **Quebrar a UI em uma hierarquia de componentes**: Dividir o design em componentes e subcomponentes com base no princípio de responsabilidade única [NB:d7378de8 · Thinking in React – React].
2. **Construir uma versão estática**: Renderizar o modelo de dados sem interatividade, utilizando apenas *props* para passar dados de cima para baixo (fluxo unidirecional) [NB:d7378de8 · Thinking in React – React].
3. **Mapear a representação mínima do estado (*state*)**: Identificar dados que mudam ao longo do tempo e eliminar o que for estático, passado via props ou computável [NB:d7378de8 · Thinking in React – React].
4. **Identificar onde o estado deve residir**: Localizar todos os componentes que dependem do estado e posicionar o estado no ancestral comum mais próximo [NB:d7378de8 · Thinking in React – React].
5. **Adicionar o fluxo de dados inverso**: Passar funções de atualização de estado (*callbacks*) dos componentes pais para os componentes filhos manipuladores de eventos [NB:d7378de8 · Thinking in React – React].

#### **Web Vitals e Core Web Vitals**
Iniciativa criada pelo Google para unificar e simplificar os sinais de qualidade da experiência do usuário [NB:d7378de8 · Web Vitals | Articles | web.dev]. Os **Core Web Vitals** cobrem três aspectos chave no percentil 75 de acessos [NB:d7378de8 · Web Vitals | Articles | web.dev]:
1. **Largest Contentful Paint (LCP)**: Desempenho de carregamento do maior bloco de conteúdo visual. Meta: **<= 2,5 segundos** [NB:d7378de8 · Web Vitals | Articles | web.dev].
2. **Interaction to Next Paint (INP)**: Mede a interatividade e o tempo de resposta da página a ações do usuário. Meta: **<= 200 milissegundos** [NB:d7378de8 · Web Vitals | Articles | web.dev].
3. **Cumulative Layout Shift (CLS)**: Mede a estabilidade visual para evitar deslocamentos inesperados de elementos. Meta: **<= 0,1** [NB:d7378de8 · Web Vitals | Articles | web.dev].
* **Ciclo de Vida**: As métricas evoluem pelas fases *Experimental*, *Pending* (com prazo mínimo de 6 meses) e *Stable* [NB:d7378de8 · Web Vitals | Articles | web.dev].

#### **Performance Web**
A abrange o tempo objetivo de carregamento e execução, assim como a percepção subjetiva de fluidez pelo usuário [NB:d7378de8 · Web performance | MDN].
* **Critical Rendering Path**: Sequência de etapas que o navegador realiza para converter HTML, CSS e JavaScript em pixels na tela (envolvendo DOM, CSSOM, Render Tree e Layout) [NB:d7378de8 · Web performance | MDN].
* **Técnicas de Otimização**: Uso de *Lazy loading* para adiar recursos não críticos [NB:d7378de8 · Web performance | MDN], *Speculative loading* e *DNS-prefetch* [NB:d7378de8 · Web performance | MDN], estabelecimento de orçamentos de desempenho (*performance budgets*) [NB:d7378de8 · Web performance | MDN] e combinação de monitoramento sintético (em ambiente de teste) com RUM (*Real User Monitoring*, com dados reais de campo) [NB:d7378de8 · Web performance | MDN].

#### **Acessibilidade WCAG 2.2**
Padrão internacional do W3C para garantir que o conteúdo web seja acessível a pessoas com diferentes deficiências [NB:d7378de8 · Web Content Accessibility Guidelines (WCAG) 2.2].
* **Princípios (POUR)**: Conteúdo deve ser **Perceptível**, **Operável**, **Compreensível** e **Robusto** [NB:d7378de8 · Web Content Accessibility Guidelines (WCAG) 2.2].
* **Níveis de Conformidade**: A (mínimo), AA e AAA (máximo) [NB:d7378de8 · Web Content Accessibility Guidelines (WCAG) 2.2].
* **Pontos Chave**: O WCAG 2.2 adiciona critérios focados em navegação por teclado sem armadilhas (`2.1.1` e `2.1.2`) [NB:d7378de8 · Web Content Accessibility Guidelines (WCAG) 2.2], tempo ajustável para ações [NB:d7378de8 · Web Content Accessibility Guidelines (WCAG) 2.2], e novos critérios de legibilidade e autenticação acessível que dispensam testes cognitivos complexos (como resolver quebra-cabeças) [NB:d7378de8 · Web Content Accessibility Guidelines (WCAG) 2.2].

---

### 5. Microsserviços: Benefícios e Riscos

#### **Definição e Características**
A arquitetura de microsserviços desenvolve uma aplicação como uma suíte de pequenos serviços independentes. Cada serviço executa em seu próprio processo e se comunica através de mecanismos leves (frequentemente APIs HTTP/REST ou mensageria) [NB:d7378de8 · Microservices]:
* **Capabilities de Negócio**: Organização dos times e serviços ao redor de capacidades do negócio (obedecendo à Lei de Conway), utilizando equipes multidisciplinares [NB:d7378de8 · Microservices].
* **Produtos, não Projetos**: Propriedade contínua do produto pelo time no modelo *"you build it, you run it"* [NB:d7378de8 · Microservices].
* **Smart Endpoints and Dumb Pipes**: Lógica desacoplada presente nos serviços terminais, com infraestrutura de rede e barramentos simples (como RabbitMQ ou HTTP) [NB:d7378de8 · Microservices].
* **Descentralização**: Governança técnica livre para adotar diferentes linguagens [NB:d7378de8 · Microservices] e gestão de dados descentralizada (**Polyglot Persistence**), em que cada serviço administra sua própria base de dados [NB:d7378de8 · Microservices].
* **Consistência Eventual**: Eliminação de transações distribuídas ACID em favor de coordenação assíncrona e operações compensatórias [NB:d7378de8 · Microservices].
* **Design para Falhas (*Design for Failure*)**: Aplicações preparadas para suportar a indisponibilidade de serviços parceiros, utilizando padrões como *Circuit Breakers* [NB:d7378de8 · Microservices].

#### **Benefícios**
* **Independência de Implantação e Escala**: Alterar um único componente exige apenas o deploy desse serviço específico, sem necessidade de reconstruir o monolito inteiro [NB:d7378de8 · Microservices].
* **Fronteiras Modulares Rígidas**: A comunicação por chamadas remotas impõe um limite explícito e dificulta acoplamentos indesejados entre módulos [NB:d7378de8 · Microservices].
* **Evolução e Heterogeneidade**: Permite que diferentes partes do sistema evoluam ou sejam reescritas em linguagens mais adequadas a cada problema específico [NB:d7378de8 · Microservices].

#### **Riscos e Desafios**
* **Custo e Latência de Rede**: Chamadas remotas são significativamente mais lentas e custosas do que chamadas em memória [NB:d7378de8 · Microservices]. Chamadas síncronas em cadeia geram o efeito multiplicativo de indisponibilidade [NB:d7378de8 · Microservices].
* **Complexidade Operacional**: Exige alto investimento em automação de infraestrutura, observabilidade, rastreamento e gestão de implantações em topologias complexas [NB:d7378de8 · Microservices; NB:d7378de8 · [2008.07729] A Systematic Mapping Study on Microservices Architecture in DevOps].
* **Dificuldade de Refatoração de Fronteiras**: Se as fronteiras dos microsserviços forem mal definidas inicialmente, mover código e refatorar interfaces distribuídas é drasticamente mais difícil do que em bibliotecas monolíticas [NB:d7378de8 · Microservices].
* **Complexidade de Conexão**: Se a decomposição não for limpa, a complexidade é simplesmente transferida do interior do código para a camada de conexões entre os serviços [NB:d7378de8 · Microservices].
* **Requisito de Alta Maturidade**: Exige equipes técnicas altamente qualificadas e disciplinadas; times com baixa maturidade tendem a reproduzir arquiteturas confusas e de difícil manutenção [NB:d7378de8 · Microservices].

---

💡 **Sugestão de próximo passo**: Como cobrimos uma ampla variedade de temas de backend, segurança e frontend, gostaria que eu aprofundasse em algum tópico específico ou elaborasse um guia estritamente focado em práticas de segurança REST e testes de contrato?

## Fontes citadas (15)

- Cloud Design Patterns - Azure Architecture Center | Microsoft Learn
- DORA | DORA’s software delivery performance metrics
- Google SRE - Site reliability engineering book Google index
- Microservices
- OWASP Top 10:2025
- REST Security - OWASP Cheat Sheet Series
- RFC 9110: HTTP Semantics
- The Practical Test Pyramid
- The Twelve-Factor App
- Thinking in React – React
- Web Content Accessibility Guidelines (WCAG) 2.2
- Web Vitals | Articles | web.dev
- Web performance | MDN
- [1908.10337] Continuous Architecting with Microservices and DevOps: A Systematic Mapping Study
- [2008.07729] A Systematic Mapping Study on Microservices Architecture in DevOps
