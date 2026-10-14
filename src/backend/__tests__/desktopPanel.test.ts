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
  it('não referencia nenhum host externo', () => {
    const hosts = [...code.matchAll(/https?:\/\/([^\s"/\\)]+)/g)].map((m) => m[1]);
    for (const h of hosts) assert.match(h, /^127\.0\.0\.1(:|\\|$)/, `host externo no painel: ${h}`);
  });
  it('o servidor só escuta em loopback (HOST fixo 127.0.0.1 ao iniciar o filho)', () => {
    assert.match(code, /env\["HOST"\]\s*=\s*"127\.0\.0\.1"/);
  });
});
