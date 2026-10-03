"""Testes do parser PURO de intenção em nuvem (F11 adendo). Rodar: python3 scripts/worker/test_intent_parser.py"""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from worker import parse_intent_json, content_grounded  # noqa: E402


def j(**kw):
    return json.dumps(kw)


assert parse_intent_json(j(intent="HORA")) == ("HORA", None)
assert parse_intent_json(j(intent="DATA", content="ignorado")) == ("DATA", None)
assert parse_intent_json(j(intent="NENHUMA")) == ("NENHUMA", None)
assert parse_intent_json(j(intent="LEMBRETE_CRIAR", content=" ligar pro dentista ")) == ("LEMBRETE_CRIAR", "ligar pro dentista")
assert parse_intent_json(j(intent="LEMBRETE_APAGAR", content="x")) == ("LEMBRETE_APAGAR", None)
assert parse_intent_json(j(intent="MEMORIA_ESQUECER")) == ("MEMORIA_ESQUECER", None)
# criar/editar/guardar sem conteúdo utilizável => NENHUMA (nada a salvar)
assert parse_intent_json(j(intent="NOTA_CRIAR")) == ("NENHUMA", None)
assert parse_intent_json(j(intent="MEMORIA_EDITAR", content="   ")) == ("NENHUMA", None)
assert parse_intent_json(j(intent="NOTA_EDITAR", content="x" * 201)) == ("NENHUMA", None)
# saída inválida => None (nuvem indisponível, cai no local)
for bad in ["", "não é json", "[]", "null", j(intent="APAGAR_TUDO"), j(intent=""), j(foo="bar"), j(intent=5)]:
    assert parse_intent_json(bad) is None, bad
# caixa
assert parse_intent_json(j(intent="hora")) == ("HORA", None)
# ancoragem do conteúdo na fala
assert content_grounded("Comprar leite e queijo", "não era compra pão era compra leite e queijo")
assert content_grounded("Mora em Campinas", "eu moro em campinas agora")
assert not content_grounded("Tem diabetes tipo dois", "eu gosto de café")
assert parse_intent_json(j(intent="MEMORIA_GUARDAR", content="tem diabetes tipo dois"), "eu gosto de café") == ("NENHUMA", None)
assert parse_intent_json(j(intent="LEMBRETE_CRIAR", content="ligar pro dentista"), "me lembra de ligar pro dentista") == ("LEMBRETE_CRIAR", "ligar pro dentista")
print("ok")
