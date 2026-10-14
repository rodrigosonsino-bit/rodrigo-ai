# T6 — ícone na barra de menus, atalho global e painel flutuante (implementação)

**Estado:** implementado e verificado em execução real neste Mac em 2026-10-13 (ver "Verificado"). **Não auditado em código.**

## Desvio do plano, registrado
O plano v2.6 (§3.6) aprovava só o **spike C** (janela de app do Chrome + atalho do macOS) e deixava o app nativo (opção D) "com plano e auditoria próprios". O Rodrigo pediu em 2026-10-13, à noite: "quero acordar com o app funcionando inclusive a T6" e "tire suas dúvidas com o Jev". O Jev recomendou a opção D (0,94, confiança 0,91; consulta feita por outra sessão, não reproduzida aqui), sinalizando que contraria a aprovação anterior. Por isso a D foi escrita **isolada em `desktop/`**, sem tocar no servidor, só loopback. Este documento é o registro do desvio; ele não substitui a auditoria que o plano exige.

## O que é
`desktop/main.swift` (180 linhas, só frameworks do macOS) compila para `desktop/build/Rodrigo AI.app` (`./desktop/build.sh`, assinatura ad hoc, uso local).
- **Ícone na barra de menus** (`waveform.circle`): clique alterna o painel; botão direito abre o menu (mostrar/ocultar, recarregar, sair).
- **Atalho global ⌘⇧Espaço** (Carbon `RegisterEventHotKey`, **não pede permissão de Acessibilidade**). Esc fecha o painel.
- **Painel flutuante** (`NSPanel`, nível flutuante, em todos os espaços) com um `WKWebView` que carrega `http://127.0.0.1:PORT`: mesma origem do app, então Host, Origin e token por sessão continuam valendo.
- **Servidor:** se `/api/health` não responde, o app inicia `node dist/server/backend/index.js` (HOST fixo 127.0.0.1) e o encerra ao sair (inclusive em SIGTERM/SIGINT).

## Fronteiras (teste estrutural `desktopPanel.test.ts`)
Sem área de transferência; inspetor desligado; armazenamento de dados **não persistente** (a conversa não sobrevive ao encerramento); navegação só para `127.0.0.1:PORT` (resto cancelado, janelas novas negadas); **microfone só para essa origem**, câmera negada; nenhum host externo no código.

## Verificado (execução real, 2026-10-13 22:45)
Binário em modo diagnóstico, porta 4601: servidor iniciado pelo app; `RegisterEventHotKey status=0`; página carregou no painel (`isSecureContext: true`, `navigator.mediaDevices: object`); captura de tela mostrou o painel no canto superior direito. **Não verificado (depende do Rodrigo):** o prompt de permissão do microfone na primeira vez, uma conversa por voz de ponta a ponta dentro do painel, e se ⌘⇧Espaço conflita com outro atalho seu (Spotlight/Alfred etc.).

## Como usar
```bash
npm run build && ./desktop/build.sh
"desktop/build/Rodrigo AI.app/Contents/MacOS/RodrigoAI"      # ou: open "desktop/build/Rodrigo AI.app"
```
Reconstruir muda a assinatura ad hoc, e o macOS pede o microfone de novo. Para abrir no login: Ajustes do Sistema → Geral → Itens de login → adicionar o app (não fiz isso por você: é configuração do sistema).

## Limites declarados
Painel não persiste a conversa (decisão do plano); o app depende de `dist/` já construído; a porta padrão é 3000 (`PORT` no ambiente muda); atalho fixo (mudar exige recompilar).
