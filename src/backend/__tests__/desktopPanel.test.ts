import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * T6 (plano v2.6 §3.6): testes ESTRUTURAIS do app de barra de menus (desktop/main.swift). São varreduras do código, não
 * execução: declaram o que o painel NÃO pode fazer. A execução real (ícone, atalho, microfone) é verificada à mão.
 */
const src = fs.readFileSync(path.join(process.cwd(), 'desktop', 'main.swift'), 'utf-8');
const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('painel desktop (T6): fronteiras declaradas', () => {
  it('não usa a área de transferência (nem leitura nem escrita)', () => {
    assert.doesNotMatch(code, /NSPasteboard|UIPasteboard|\.pasteboard|setString\(.*forType/);
  });
  it('não ativa ferramentas de depuração e mantém o inspetor desligado', () => {
    assert.doesNotMatch(code, /developerExtrasEnabled|isInspectable\s*=\s*true/);
    assert.match(code, /isInspectable\s*=\s*false/);
  });
  it('não persiste a conversa (armazenamento de dados não persistente)', () => {
    assert.match(code, /websiteDataStore\s*=\s*\.nonPersistent\(\)/);
  });
  it('só navega para a origem do app (127.0.0.1 na porta do app) e bloqueia o resto', () => {
    assert.match(code, /u\.host == "127\.0\.0\.1" && u\.port == port/);
    assert.match(code, /decisionHandler\(ok \? \.allow : \.cancel\)/);
    assert.match(code, /createWebViewWith[\s\S]*?\{ nil \}/, 'não abre janelas novas');
  });
  it('só a origem do app recebe o microfone; câmera e o resto são negados', () => {
    assert.match(code, /type == \.microphone/);
    assert.match(code, /o\.host == "127\.0\.0\.1"/);
  });
  it('bloqueia a REDE (fetch/XHR/WebSocket/subrecursos), não só a navegação: regra de conteúdo com exceção só para 127.0.0.1:PORT', () => {
    assert.match(code, /compileContentRuleList/);
    assert.match(code, /"url-filter":"\^https\?:\/\/"\},"action":\{"type":"block"\}/);
    assert.match(code, /"url-filter":"\^wss\?:\/\/"/);
    assert.match(code, /ignore-previous-rules/);
    // O WebKit NÃO aceita alternância (|) nas regras: uma regra assim não compila e o bloqueio some em silêncio.
    const filters = [...code.matchAll(/"url-filter":"([^"]*)"/g)].map((m) => m[1]);
    for (const f of filters) assert.doesNotMatch(f, /\|/, `alternância não suportada no filtro: ${f}`);
  });
  it('o servidor filho encerra sozinho se o app morrer (RODRIGO_PARENT_PID)', () => {
    assert.match(code, /RODRIGO_PARENT_PID/);
  });
  it('o contador de uso grava só carimbos de tempo (sem conteúdo nem nome de app) e o foco volta ao app anterior', () => {
    const rec = code.slice(code.indexOf('func recordUsage'), code.indexOf('func recordUsage') + 700);
    assert.match(rec, /keyToVisibleMs/);
    assert.doesNotMatch(rec, /localizedName|bundleIdentifier|evaluateJavaScript|innerText|transcript/);
    assert.match(code, /previousApp/);
    assert.match(code, /p\.activate\(options: \[\]\)/);
  });
  it('Esc é capturado por um monitor local (o WKWebView consome o Esc antes do painel)', () => {
    assert.match(code, /addLocalMonitorForEvents\(matching: \.keyDown\)/);
    assert.match(code, /e\.keyCode == 53/);
  });
  it('não referencia nenhum host externo', () => {
    const noRules = code.replace(/"url-filter":"[^"]*"/g, ''); // as regras de bloqueio citam 127.0.0.1 como regex
    const hosts = [...noRules.matchAll(/https?:\/\/([^\s"/\\)]+)/g)].map((m) => m[1]);
    // example.com aparece só no diagnóstico (RODRIGO_DESKTOP_DEBUG=1), que TENTA um fetch externo para provar que ele é bloqueado.
    for (const h of hosts) assert.match(h, /^(127\.0\.0\.1(:|\\|$)|example\.com\/?$)/, `host externo no painel: ${h}`);
  });
  it('o servidor só escuta em loopback (HOST fixo 127.0.0.1 ao iniciar o filho)', () => {
    assert.match(code, /env\["HOST"\]\s*=\s*"127\.0\.0\.1"/);
  });
});
