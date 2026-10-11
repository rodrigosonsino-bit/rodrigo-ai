#!/usr/bin/env python3
"""Sincronizador de cadernos NotebookLM para o Orchestrador de Voz (Rodrigo AI).

Lista cadernos, filtra os relevantes (Teologia, Virtologia, Neurociencia,
Hermeneutica, etc.) e baixa o fulltext de todas as fontes de cada um para
docs/research/. Resumivel: pula fonte cujo arquivo de destino ja existe
(nao-vazio), para poder reiniciar apos interrupcao sem re-baixar o que ja
foi salvo.
"""
import json
import os
import re
import subprocess
import sys
import time

REPO_ROOT = '/Users/rodrigosonsino/Documents/Codex/2026-09-11/referenced-chatgpt-conversation-this-is-an/outputs/rodrigo-ai'
RESEARCH_DIR = os.path.join(REPO_ROOT, 'docs', 'research')

KEYWORDS = [
    'teologia', 'novo testamento', 'antigo testamento', 'hermenêutica',
    'hermeneutica', 'exegese', 'dicionário', 'dicionario', 'lexico',
    'neuro', 'neurociência', 'virtologia', 'virtuologia',
]


def run_cli(args, timeout=120):
    try:
        result = subprocess.run(
            ['notebooklm'] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=REPO_ROOT,
        )
        return result.stdout, result.returncode
    except subprocess.TimeoutExpired:
        return '', 124
    except Exception as e:
        return str(e), 1


def safe_filename(s, maxlen=80):
    s = "".join(c for c in s if c.isalnum() or c in ' _-').strip()
    s = re.sub(r'\s+', '_', s)
    return s[:maxlen]


def list_notebooks():
    stdout, rc = run_cli(['list', '--json'])
    if rc != 0:
        print("Falha ao listar cadernos:", stdout[:300], flush=True)
        return []
    try:
        return json.loads(stdout).get('notebooks', [])
    except json.JSONDecodeError:
        print("JSON invalido no list.", flush=True)
        return []


def list_sources(notebook_id):
    stdout, rc = run_cli(['source', 'list', '-n', notebook_id, '--json'])
    if rc != 0:
        return []
    try:
        return json.loads(stdout).get('sources', [])
    except json.JSONDecodeError:
        return []


def get_fulltext(notebook_id, source_id):
    stdout, rc = run_cli(['source', 'fulltext', source_id, '-n', notebook_id, '--json'], timeout=180)
    if rc != 0:
        return None, rc
    try:
        data = json.loads(stdout)
        return data.get('content') or data.get('fulltext') or data.get('text'), 0
    except json.JSONDecodeError:
        return None, 1


def main():
    print(f"=== Sincronizador de Cadernos NotebookLM — {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n", flush=True)
    os.makedirs(RESEARCH_DIR, exist_ok=True)
    print(f"Destino: {RESEARCH_DIR}\n", flush=True)

    notebooks = list_notebooks()
    print(f"Total de cadernos na conta: {len(notebooks)}", flush=True)

    relevant = [nb for nb in notebooks
                if any(k in nb.get('title', '').lower() for k in KEYWORDS)]
    print(f"Cadernos relevantes: {len(relevant)}\n", flush=True)

    total_files = 0
    total_skipped = 0
    total_sources = 0
    errors = []

    for nb in relevant:
        nb_id = nb['id']
        nb_title = nb.get('title', 'Sem titulo')
        print(f"\n> {nb_title}", flush=True)
        print(f"  id={nb_id}", flush=True)

        sources = list_sources(nb_id)
        if not sources:
            print("  (sem fontes)", flush=True)
            continue
        print(f"  {len(sources)} fontes", flush=True)

        nb_dir = os.path.join(RESEARCH_DIR, f"{safe_filename(nb_title)}__{nb_id[:8]}")
        os.makedirs(nb_dir, exist_ok=True)
        total_sources += len(sources)

        for src in sources:
            src_id = src.get('id', '')
            src_title = src.get('title', 'fonte')
            src_status = src.get('status', '?')

            fname = f"{safe_filename(src_title)}__{src_id[:8]}.md"
            fpath = os.path.join(nb_dir, fname)

            if os.path.exists(fpath) and os.path.getsize(fpath) > 0:
                total_skipped += 1
                print(f"    = {src_title} (ja existe, pulando)", flush=True)
                continue

            if src_status != 'ready':
                print(f"    x {src_title} (status={src_status}, pulando)", flush=True)
                continue

            content, rc = get_fulltext(nb_id, src_id)
            if not content:
                errors.append((nb_title, src_title, rc))
                print(f"    x {src_title} (fulltext falhou rc={rc})", flush=True)
                continue

            with open(fpath, 'w', encoding='utf-8') as f:
                f.write(f"# {src_title}\n")
                f.write(f"<!-- notebook={nb_id} source={src_id} type={src.get('type','?')} url={src.get('url','')} -->\n\n")
                f.write(content)
            total_files += 1
            print(f"    + {src_title} ({len(content)} chars)", flush=True)
            time.sleep(0.3)

    print("\n=== Concluido ===", flush=True)
    print(f"Novos arquivos: {total_files} | Ja existiam (pulados): {total_skipped} | de {total_sources} fontes em {len(relevant)} cadernos", flush=True)
    print(f"Pasta: {RESEARCH_DIR}", flush=True)
    if errors:
        print(f"Falhas: {len(errors)}", flush=True)
        for nb_t, src_t, rc in errors[:20]:
            print(f"  - [{nb_t}] {src_t} (rc={rc})", flush=True)


if __name__ == '__main__':
    main()
