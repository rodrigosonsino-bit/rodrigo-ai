import os, json, tempfile, shutil, uuid
d = tempfile.mkdtemp(prefix="t4exp-"); LOG = os.path.join(d, "audit.jsonl"); STORE = os.path.join(d, "lembretes.json")
class Boom(Exception): pass
def append(rec, fail=False):
    if fail: raise OSError("disco cheio (injetado)")
    with open(LOG, "a") as f: f.write(json.dumps(rec) + "\n"); f.flush(); os.fsync(f.fileno())
def store_load(): return json.load(open(STORE)) if os.path.exists(STORE) else {}
def mutate(mid, text):                      # mutação atômica e idempotente por id
    s = store_load(); s[mid] = text; tmp = STORE + ".tmp"
    json.dump(s, open(tmp, "w")); os.rename(tmp, STORE)
def turno(texto, falha_intencao=False, falha_conclusao=False, crash_apos_intencao=False, crash_durante=False):
    mid = uuid.uuid4().hex[:6]
    try: append({"id": mid, "fase": "intencao", "classe": "LEMBRETE_CRIAR"}, falha_intencao)
    except OSError: return mid, "MUTAÇÃO RECUSADA (intenção não gravada)"
    if crash_apos_intencao: return mid, "CRASH depois da intenção, antes da mutação"
    mutate(mid, texto)
    if crash_durante: return mid, "CRASH depois da mutação, antes da conclusão"
    try: append({"id": mid, "fase": "conclusao", "ok": True}, falha_conclusao)
    except OSError: return mid, "mutação FEITA, conclusão não gravada (aviso falado)"
    return mid, "ok"
def recuperacao(naive):
    recs = [json.loads(l) for l in open(LOG)] if os.path.exists(LOG) else []
    concl = {r["id"] for r in recs if r["fase"] == "conclusao"}; st = store_load(); out = {}
    for r in recs:
        if r["fase"] == "intencao" and r["id"] not in concl:
            out[r["id"]] = "sem conclusão" if naive else ("APLICADA, conclusão perdida" if r["id"] in st else "NÃO aplicada")
    return out
cen = [("S1 falha ao gravar a intenção", dict(falha_intencao=True)),
       ("S2 crash após a intenção, antes da mutação", dict(crash_apos_intencao=True)),
       ("S3 falha ao gravar a conclusão", dict(falha_conclusao=True)),
       ("S4 crash após a mutação, antes da conclusão", dict(crash_durante=True))]
ids = {}
for nome, kw in cen:
    mid, r = turno("lembrete " + nome[:2], **kw); ids[mid] = nome; print(f"{nome:50s} -> {r} | no store: {mid in store_load()}")
print("\nrecuperação na v2.2/v2.3 (marca 'sem conclusão', não olha o store):")
for mid, v in recuperacao(True).items(): print("  ", ids[mid][:2], v, "| realmente no store:", mid in store_load())
print("\nrecuperação proposta (cruza a intenção com o store por id):")
for mid, v in recuperacao(False).items(): print("  ", ids[mid][:2], v)
shutil.rmtree(d)
