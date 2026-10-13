"""v2.6: refaz o protótipo da T4 com o FORMATO REAL do JsonStore ({items:[{id,text,...}]}, sem mutationId por item)
e com as TRÊS operações (criar, editar, apagar). Compara duas recuperações:
 - por item (v2.5): procura o mutationId nos itens  -> quebra na exclusão
 - por marcador 'applied' no MESMO arquivo, gravado na MESMA troca atômica (v2.6)."""
import os, json, tempfile, shutil, uuid, itertools
d = tempfile.mkdtemp(prefix="t4b-"); LOG = os.path.join(d, "audit.jsonl"); STORE = os.path.join(d, "lembretes.json")
def load():
    return json.load(open(STORE)) if os.path.exists(STORE) else {"items": [], "applied": []}
def save(st):                                   # atômico: tmp + rename (como o JsonStore)
    tmp = STORE + ".tmp"; json.dump(st, open(tmp, "w")); os.rename(tmp, STORE)
def log(rec):
    with open(LOG, "a") as f: f.write(json.dumps(rec) + "\n"); f.flush(); os.fsync(f.fileno())
def mutate(op, mid, target=None, text=None, marcador=True):
    st = load()
    if op == "criar": st["items"].append({"id": uuid.uuid4().hex[:4], "text": text})
    elif op == "editar":
        for it in st["items"]:
            if it["id"] == target: it["text"] = text
    elif op == "apagar": st["items"] = [it for it in st["items"] if it["id"] != target]   # igual ao splice real
    if marcador: st["applied"].append({"mid": mid})        # MESMA gravação atômica da mudança
    save(st)
def turno(op, target=None, text=None, crash_antes=False, crash_apos_mutacao=False, marcador=True):
    mid = uuid.uuid4().hex[:6]; log({"mid": mid, "fase": "intencao", "op": op, "target": target})
    if crash_antes: return mid
    mutate(op, mid, target, text, marcador)
    if crash_apos_mutacao: return mid               # cai antes de gravar a conclusão
    log({"mid": mid, "fase": "conclusao"}); return mid
def recuperar(modo):
    recs = [json.loads(l) for l in open(LOG)]; concl = {r["mid"] for r in recs if r["fase"] == "conclusao"}; st = load()
    applied = {a["mid"] for a in st["applied"]}; ids = {it["id"] for it in st["items"]}; out = {}
    for r in recs:
        if r["fase"] != "intencao" or r["mid"] in concl: continue
        if modo == "marcador": out[r["mid"]] = "APLICADA" if r["mid"] in applied else "NÃO aplicada"
        else:   # v2.5: heurística por item: 'o id do alvo ainda está nos itens?'
            if r["op"] == "apagar": out[r["mid"]] = "NÃO aplicada" if r["target"] in ids else "AMBÍGUO (item sumiu: apagado agora ou antes?)"
            else: out[r["mid"]] = "aplicada?" if True else ""
    return out
base = turno("criar", text="A"); base_id = load()["items"][0]["id"]
casos = [("criar,  crash antes da mutação", dict(op="criar", text="B", crash_antes=True)),
         ("criar,  crash depois da mutação", dict(op="criar", text="C", crash_apos_mutacao=True)),
         ("editar, crash antes da mutação", dict(op="editar", target=base_id, text="X", crash_antes=True)),
         ("editar, crash depois da mutação", dict(op="editar", target=base_id, text="Y", crash_apos_mutacao=True)),
         ("apagar, crash antes da mutação", dict(op="apagar", target=base_id, crash_antes=True)),
         ("apagar, crash depois da mutação", dict(op="apagar", target=base_id, crash_apos_mutacao=True))]
mids = {}
for nome, kw in casos:
    mids[turno(**kw)] = nome
print("estado final do store (itens):", [it["text"] for it in load()["items"]])
print("\nRECUPERAÇÃO v2.5 (heurística por item):")
for m, v in recuperar("item").items(): print(f"  {mids[m]:34s} -> {v}")
print("\nRECUPERAÇÃO v2.6 (marcador 'applied' na mesma gravação):")
for m, v in recuperar("marcador").items(): print(f"  {mids[m]:34s} -> {v}")
shutil.rmtree(d)
