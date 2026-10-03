#!/usr/bin/env python3
"""
Worker persistente de voz local (Fase 2, Rodrigo AI).

Protocolo: NDJSON via stdin/stdout.
- stdout carrega EXCLUSIVAMENTE o protocolo (uma linha JSON por evento). Nunca escrever
  transcrições, texto de conversa ou segredos em stderr; stderr é só para diagnóstico técnico.
- Comandos chegam por stdin (um JSON por linha): transcribe, generate, cancel, ping.
- Uma thread dedicada (`_stdin_reader_loop`) lê stdin continuamente e nunca bloqueia em
  inferência — comandos "cancel" são aplicados imediatamente a partir dela, mesmo enquanto
  a thread de trabalho está presa dentro de stream_generate (achado de auditoria: um único
  thread que faz as duas coisas não consegue processar cancelamento a tempo).
- Apenas uma tarefa de inferência roda por vez (fila de tamanho 1): um novo comando
  "generate" cancela e substitui qualquer geração em andamento, nunca enfileira atrás dela.

Modelos (MLX, 100% local, sem rede em operação):
- LLM: mlx-community/Qwen3-4B-Instruct-2507-4bit
- STT: mlx-community/whisper-small-mlx

Offline por padrão: HF_HUB_OFFLINE=1 / TRANSFORMERS_OFFLINE=1 são setados antes de importar
qualquer biblioteca de rede, exceto durante o setup explícito (scripts/setup-voice.mjs), que
roda este mesmo worker com HF_HUB_OFFLINE=0 apenas para baixar/materializar os modelos.
"""
import difflib
import json
import os
import queue
import re
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Optional

# Offline em operação normal — o setup script sobrescreve isso explicitamente para baixar modelos.
if os.environ.get("RODRIGO_VOICE_SETUP") != "1":
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

CACHE_LIMIT_BYTES = 1024 * 1024 * 1024  # 1 GiB — Achado v2-8: API moderna, não mx.metal.*
LLM_MODEL_ID = "mlx-community/Qwen3-4B-Instruct-2507-4bit"
CLASSIFICATION_LABELS = frozenset({"GERAL", "TEOLOGIA", "VIRTOLOGIA", "AMBIGUO"})
CLASSIFICATION_SYSTEM_PROMPT = (
    "Você classifica uma frase do usuário em EXATAMENTE uma categoria. "
    "Responda com UMA ÚNICA PALAVRA, sem pontuação, sem explicação: "
    "GERAL, TEOLOGIA, VIRTOLOGIA ou AMBIGUO.\n"
    "TEOLOGIA: perguntas sobre a Bíblia, exegese, doutrina cristã, sermões, teologia cristã.\n"
    "VIRTOLOGIA: perguntas sobre os CONCEITOS e terminologia técnica da área chamada "
    "Virtologia — só quando a frase pede para explicar, definir ou discutir o conceito em "
    "si dentro desse método/abordagem.\n"
    "GERAL: qualquer outra coisa — matemática, conversa cotidiana, perguntas factuais gerais, "
    "pedidos de ação/ferramenta (ainda não implementados, tratar como GERAL). Isso inclui "
    "frases que usam palavras que TAMBÉM aparecem como termos técnicos em outra categoria, "
    "mas aqui no sentido comum do dia a dia (ex.: 'aceitação', 'perdão', 'graça' usadas como "
    "sentimento ou experiência pessoal, não como conceito técnico sendo explicado).\n"
    "AMBIGUO: a frase pertence claramente a mais de uma categoria acima, ou não há "
    "contexto suficiente pra decidir com confiança.\n"
    "Exemplos que distinguem sentido técnico de sentido cotidiano da MESMA palavra:\n"
    "- 'Explique o conceito de Aceitação nesse método' -> VIRTOLOGIA (pede o conceito técnico).\n"
    "- 'Preciso de mais aceitação da minha família' -> GERAL (sentimento cotidiano, não pede o conceito)."
)
TOOL_NAMES = {"HORA", "DATA", "NENHUMA"}

DETECT_TOOL_SYSTEM_PROMPT = (
    "Você decide se a frase do usuário pede a HORA atual, a DATA de hoje, ou NENHUMA das duas. "
    "Responda com UMA ÚNICA PALAVRA, sem pontuação, sem explicação: HORA, DATA ou NENHUMA.\n"
    "HORA: o usuário quer saber que horas são agora, neste lugar. Vale para qualquer jeito de "
    "perguntar, inclusive coloquial: 'que horas vocês têm aí', 'alguém sabe as horas', "
    "'dá pra ver que horas são', 'tô sem relógio, que horas são', 'me diz as horas', "
    "'preciso saber a hora certa agora'.\n"
    "DATA: o usuário quer saber que dia é hoje, o dia da semana, o mês ou o ano atuais. Também "
    "vale coloquial: 'em que dia da semana estamos', 'qual a data de hoje', 'que dia do mês é "
    "hoje', 'estamos em que ano', 'me diz que dia é hoje', 'qual o dia certo hoje'.\n"
    "NENHUMA: todo o resto. Isso INCLUI perguntas sobre tempo que não são a hora ou a data de "
    "agora aqui: hora em outro fuso ou país, datas passadas ou futuras, quanto tempo falta para "
    "algo, duração, aniversário, feriado, horário de funcionamento, ou qualquer cálculo com datas "
    "— e também perguntas de outro assunto que apenas mencionam uma palavra de tempo de "
    "passagem.\n"
    "Exemplos:\n"
    "Que horas vocês têm aí? -> HORA\n"
    "Alguém sabe as horas? -> HORA\n"
    "Dá pra ver que horas são? -> HORA\n"
    "Tô sem relógio, que horas são? -> HORA\n"
    "Em que dia da semana estamos? -> DATA\n"
    "Qual a data de hoje? -> DATA\n"
    "Estamos em que mês mesmo? -> DATA\n"
    "Que horas são em Lisboa agora? -> NENHUMA\n"
    "Em que dia da semana caiu o Natal do ano passado? -> NENHUMA\n"
    "Quanto tempo dura uma consulta médica? -> NENHUMA\n"
    "A que horas abre a padaria? -> NENHUMA\n"
    "Fale sobre o significado da graça na vida cristã. -> NENHUMA\n"
    "Já deu meio-dia ou não? -> HORA\n"
    "Tá tarde já, né? -> HORA\n"
    "Hoje é dia quantos, perdi a conta -> DATA\n"
    "Hoje é dia de quê? -> DATA\n"
    "Já passou das dez? -> HORA\n"
    "Tá cedo ainda ou já passou das três? -> HORA\n"
    "Tem gente que nasceu de dia e eu nasci de tardinha -> NENHUMA\n"
    "Hora de dormir passou faz tempo -> NENHUMA\n"
    "Hora certa ninguém acerta de primeira -> NENHUMA\n"
    "A nota de cem tá acabando do caixa eletrônico -> NENHUMA\n"
    "Chegou a hora da verdade, meu amigo -> NENHUMA\n"
    "Hoje é dia de feira lá no bairro -> NENHUMA\n"
    "A data não importa, importa o sentimento -> NENHUMA\n"
)


def parse_tool_output(raw: str) -> str:
    """Função PURA — testada em scripts/worker/test_tool_parser.py.

    Formato inválido degrada para NENHUMA: não reconhecer intenção deve custar a ferramenta,
    nunca o turno (ao contrário do classificador, onde formato inválido é erro).
    """
    normalized = (raw or "").strip().upper().strip(".!? \n")
    return normalized if normalized in TOOL_NAMES else "NENHUMA"


MUTATION_NAMES = {
    "LEMBRETE_CRIAR", "LEMBRETE_EDITAR", "LEMBRETE_APAGAR",
    "NOTA_CRIAR", "NOTA_EDITAR", "NOTA_APAGAR",
    "MEMORIA_GUARDAR", "MEMORIA_EDITAR", "MEMORIA_ESQUECER",
    "NENHUMA"
}
MAX_MUTATION_CONTENT_CHARS = 200

DETECT_MUTATION_SYSTEM_PROMPT = (
    "Você decide se a frase do usuário pede para CRIAR, EDITAR ou APAGAR um LEMBRETE, uma NOTA "
    "ou uma MEMÓRIA, ou NENHUMA das nove. Responda em UMA LINHA: AÇÃO, ou AÇÃO|conteúdo para "
    "*_CRIAR, *_EDITAR e MEMORIA_GUARDAR (o texto do que deve ser lembrado/anotado/guardado/"
    "corrigido, sem aspas, sem explicação extra).\n"
    "LEMBRETE_CRIAR: um compromisso, tarefa ou coisa temporária a fazer — 'lembra de', 'não "
    "deixa eu esquecer', 'anota aí que eu preciso', 'bota um lembrete pra'.\n"
    "LEMBRETE_EDITAR: pede pra CORRIGIR ou TROCAR o TEXTO do lembrete mais recente, sem criar "
    "um novo e sem mudar quando ele dispara — 'troca esse lembrete pra', 'corrige o lembrete, é'. "
    "Diferença de LEMBRETE_CRIAR: EDITAR sempre se refere a um lembrete que JÁ EXISTE. "
    "IMPORTANTE: se o pedido for pra mudar o DIA ou HORÁRIO do lembrete (não o texto), NÃO é "
    "LEMBRETE_EDITAR — é NENHUMA, porque o sistema ainda não sabe reagendar um lembrete "
    "existente (só apagar e criar um novo).\n"
    "LEMBRETE_APAGAR: pede pra apagar/cancelar o lembrete mais recente — 'apaga o lembrete', "
    "'cancela aquele lembrete', 'esquece o que eu pedi pra lembrar'.\n"
    "NOTA_CRIAR: uma ideia, observação, ou texto livre pra guardar — 'guarda essa ideia', "
    "'escreve isso pra mim', 'salva essa observação', 'registra que'.\n"
    "NOTA_EDITAR: mesma ideia de LEMBRETE_EDITAR, mas pra nota.\n"
    "NOTA_APAGAR: pede pra apagar a nota mais recente — 'apaga essa nota', 'joga fora a "
    "anotação'.\n"
    "MEMORIA_GUARDAR: um FATO ou PREFERÊNCIA sobre o próprio usuário, pra você lembrar quem ele é — "
    "'lembra que eu prefiro', 'guarda que meu nome é', 'anota que eu gosto de'. Diferença de "
    "LEMBRETE_CRIAR: aqui não é uma TAREFA a fazer num momento futuro, é uma INFORMAÇÃO SOBRE A "
    "PESSOA que vale pra sempre. Diferença de NOTA_CRIAR: nota é uma ideia ou observação qualquer "
    "(sobre qualquer assunto); memória é especificamente um fato sobre QUEM O USUÁRIO É — nome, "
    "preferência, restrição, característica pessoal.\n"
    "MEMORIA_EDITAR: mesma ideia, mas pra memória.\n"
    "MEMORIA_ESQUECER: pede pra apagar o fato mais recente guardado sobre o usuário — 'apaga essa "
    "memória sobre mim', 'apaga o que você guardou sobre mim'. Diferença de LEMBRETE_APAGAR: aquele "
    "apaga uma TAREFA pendente; este apaga um FATO sobre a pessoa.\n"
    "NENHUMA: todo o resto — perguntas, pedidos de informação, conversa comum, e qualquer "
    "menção a lembrar/anotar que não seja um pedido direto de ação (ex.: 'eu lembro que você "
    "me falou isso' é NENHUMA, é o usuário lembrando de algo, não pedindo pra você lembrar).\n"
    "Exemplos:\n"
    "Lembra de ligar pro dentista -> LEMBRETE_CRIAR|Ligar pro dentista\n"
    "Troca esse lembrete pra ligar pro médico -> LEMBRETE_EDITAR|Ligar pro médico\n"
    "Na verdade, corrige o lembrete: é café solúvel, não em pó -> LEMBRETE_EDITAR|Comprar café solúvel, não em pó\n"
    "Muda esse lembrete pra sexta em vez de quinta -> NENHUMA\n"
    "Troca essa nota pra: comprar materiais na segunda -> NOTA_EDITAR|Comprar materiais na segunda\n"
    "Guarda que meu nome é Rodrigo -> MEMORIA_GUARDAR|seu nome é Rodrigo\n"
    "Na verdade, corrige isso que eu falei: meu nome é Rodrigo Sonsino -> MEMORIA_EDITAR|seu nome é Rodrigo Sonsino\n"
    "Vamos trocar de assunto agora -> NENHUMA\n"
    "Me avisa amanhã cedo que eu preciso levar o carro na oficina -> LEMBRETE_CRIAR|Levar o carro na oficina\n"
    "Muda só a frase do lembrete pra devolver o livro na biblioteca -> LEMBRETE_EDITAR|Devolver o livro na biblioteca\n"
    "O texto tá errado, bota academia às seis no lugar -> LEMBRETE_EDITAR|Academia às seis\n"
    "Some com esse lembrete aí que eu criei -> LEMBRETE_APAGAR\n"
    "Anota aí que eu preciso comprar ração pro cachorro essa semana -> NOTA_CRIAR|Comprar ração pro cachorro essa semana\n"
    "Esquece o que eu te falei agora -> MEMORIA_ESQUECER\n"
    "Apaga essa última coisa que eu te contei -> MEMORIA_ESQUECER\n"
    "Tá errado isso aí, eu faço medicina, não engenharia -> MEMORIA_EDITAR|Faz medicina, não engenharia\n"
    "Corrige aí: eu moro em Campinas agora, não em São Paulo -> MEMORIA_EDITAR|Mora em Campinas, não em São Paulo\n"
    "O juiz pediu pra anotar o depoimento inteiro -> NENHUMA\n"
    "Eu gosto de quem anota as ideias no papel -> NENHUMA\n"
    "Na real eu tenho trinta e dois anos, não trinta e cinco -> NENHUMA\n"
    "Anota aí que eu quero ser chamado de Rafa -> MEMORIA_GUARDAR|quer ser chamado de Rafa\n"
    "Anota aí que meu time é o São Paulo -> MEMORIA_GUARDAR|seu time é o São Paulo\n"
    "Anota aí que eu não gosto de acordar cedo -> MEMORIA_GUARDAR|não gosta de acordar cedo\n"
    "Anota rápido que a reunião do condomínio mudou pra quinta -> NOTA_CRIAR|Reunião do condomínio mudou pra quinta\n"
    "Reescreve a nota aí, ficou esquisita -> NOTA_EDITAR|Reescrever a nota\n"
    "Não gostei do jeito que ficou, reescreve a nota mais curto -> NOTA_EDITAR|Reescrever a nota mais curto\n"
    "Acho que falei errado, bota pagar a conta de luz no lugar -> LEMBRETE_EDITAR|Pagar a conta de luz\n"
    "Essa história de que eu gosto de futebol tá errada, apaga isso -> MEMORIA_ESQUECER\n"
    "Não era isso não, queria que tivesse escrito liga pro João -> LEMBRETE_EDITAR|Liga pro João\n"
    "Não, não é isso, muda pra reunião com cliente às três -> LEMBRETE_EDITAR|Reunião com cliente às três\n"
    "Não era compra pão, era compra leite e queijo -> LEMBRETE_EDITAR|Comprar leite e queijo\n"
    "Espera, minha mãe se chama Maria, não Marina -> MEMORIA_EDITAR|Sua mãe se chama Maria, não Marina\n"
    "Tá errado isso aí, eu tenho dois gatos, não três -> MEMORIA_EDITAR|Tem dois gatos, não três\n"
    "Cê tá confundido, eu moro em Belo Horizonte, não no Rio -> MEMORIA_EDITAR|Mora em Belo Horizonte, não no Rio\n"
    "Eu prefiro café, não chá, mas hoje vou de suco -> NENHUMA\n"
    "Nota dez na prova de matemática ontem -> NENHUMA\n"
    "Apagar a luz do quarto antes de dormir -> NENHUMA\n"
    "Lembrar de tomar remédio é uma luta -> NENHUMA\n"
)

DETECT_CONFIRMATION_SYSTEM_PROMPT = (
    "O usuário acabou de ouvir uma pergunta perguntando se ele confirma uma ação (criar, editar "
    "ou apagar algo). Responda em UMA PALAVRA: SIM se a resposta confirma a ação, NAO se nega, "
    "cancela, ou não é claramente uma confirmação.\n"
    "Exemplos:\n"
    "Isso mesmo, pode confirmar -> SIM\n"
    "Perfeito, é isso -> SIM\n"
    "Não, deixa pra lá -> NAO\n"
    "Melhor não, esquece -> NAO\n"
    "Na verdade eu quis dizer outra coisa -> NAO\n"
    "Isso aí tá errado -> NAO\n"
)


def parse_mutation_output(raw: str, truncated: bool) -> tuple[str, str | None]:
    """Função PURA — testada em scripts/worker/test_mutation_parser.py.

    `truncated` (achado 9): True quando a geração atingiu max_tokens sem terminar
    naturalmente — conteúdo pode estar cortado no meio de uma palavra, sintaticamente
    válido pro parser mas semanticamente incompleto. Degrada para NENHUMA nesse caso,
    mesma filosofia de 'melhor pedir de novo do que gravar errado' do resto da fase.
    """
    if truncated:
        return ("NENHUMA", None)
    text = (raw or "").strip()
    sep = text.find("|")
    action = (text if sep == -1 else text[:sep]).strip().upper()
    content = None if sep == -1 else text[sep + 1:].strip()

    if action not in MUTATION_NAMES:
        return ("NENHUMA", None)
    if action in ("LEMBRETE_CRIAR", "NOTA_CRIAR", "MEMORIA_GUARDAR",
                  "LEMBRETE_EDITAR", "NOTA_EDITAR", "MEMORIA_EDITAR"):
        if not content or len(content) > MAX_MUTATION_CONTENT_CHARS:
            return ("NENHUMA", None)
        return (action, content)
    return (action, None)


def parse_confirmation_output(raw: str) -> str:
    """Função PURA — testada em scripts/worker/test_mutation_parser.py.
    Formato inesperado degrada para NAO — fail closed em ação que muta estado.
    """
    normalized = (raw or "").strip().upper().strip(".!? \n")
    return "SIM" if normalized == "SIM" else "NAO"


def to_gemini_contents(messages: list[dict]) -> tuple[str, list[dict]]:
    """Separa o system prompt (identificado pelo papel 'system', em qualquer posição — não
    assume messages[0]) do resto, e consolida mensagens consecutivas do mesmo papel num único
    `content` com múltiplas `parts` — a API do Gemini exige alternância estrita user/model, e
    o histórico do Rodrigo grava cada frase falada como uma entrada 'assistant' separada
    (sessionManager.ts markPlayed()), então respostas de mais de uma frase e barge-ins geram
    sequências de papel repetido que precisam ser fundidas, não enviadas cruas."""
    system_parts = [m["content"] for m in messages if m["role"] == "system"]
    system_instruction = "\n\n".join(system_parts)

    non_system = [m for m in messages if m["role"] != "system"]

    contents: list[dict] = []
    for m in non_system:
        role = "model" if m["role"] == "assistant" else "user"
        if contents and contents[-1]["role"] == role:
            contents[-1]["parts"].append({"text": m["content"]})
        else:
            contents.append({"role": role, "parts": [{"text": m["content"]}]})

    # A API do Gemini exige que o primeiro content seja 'user' — se o histórico (caso raro,
    # praticamente só em teste) começar com 'model', descarta esse prefixo em vez de mandar uma
    # requisição malformada.
    while contents and contents[0]["role"] != "user":
        contents.pop(0)

    # Achado novo MÉDIA (rodada 2): o pop acima pode esvaziar `contents` por completo (nenhuma
    # mensagem 'user' em todo o histórico) — na prática só ocorre em teste unitário sintético
    # (em runtime real o último item de session.history antes de generate() é sempre 'user',
    # sessionManager.ts:376), mas enviar contents=[] pro Gemini gera HTTP 400 sem nenhuma
    # indicação da causa real. Falha explícita e cedo, aqui, é mais barato de depurar.
    if not contents:
        raise ValueError(
            "to_gemini_contents: histórico não contém nenhuma mensagem 'user' — nada para "
            "enviar ao Gemini."
        )

    return system_instruction, contents


STT_MODEL_ID = "mlx-community/whisper-small-mlx"
MAX_TURN_TOKENS = 160



def log_diag(message: str) -> None:
    """Diagnóstico técnico em stderr — nunca inclui transcrição ou conteúdo de conversa."""
    print(f"[worker] {message}", file=sys.stderr, flush=True)


def emit(event: dict[str, Any]) -> None:
    """Único ponto de escrita em stdout — protocolo NDJSON."""
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# --- Segmentador de frases PT-BR (Achado v2-3: não fragmentar decimais/abreviações) ---

_ABBREVIATIONS = {
    "sr", "sra", "srta", "dr", "dra", "prof", "profa", "ex", "etc",
    "ltda", "vs", "pág", "p", "ed", "nº", "art", "cap"
}

# Pontuação terminativa seguida de espaço/quebra/fim-de-string, sem ponto entre dígitos
# (ex.: "3.5"), sem reticências no meio, e com piso mínimo de conteúdo antes de fechar.
_SENTENCE_BOUNDARY = re.compile(r"([.!?]+)(\s+|$)")


def find_sentence_boundary(buffer: str) -> Optional[int]:
    """
    Retorna o índice (exclusive, após a pontuação+espaço) do primeiro limite de frase
    seguro em `buffer`, ou None se ainda não há um. Regras:
    - "3.5", "3." seguido de dígito -> não é limite (decimal/numeração).
    - Abreviação conhecida antes do ponto -> não é limite.
    - Reticências "..." contam como um único limite (não um por ponto).
    - Chunk resultante deve ter pelo menos 15 caracteres (senão adia o corte).
    """
    for match in _SENTENCE_BOUNDARY.finditer(buffer):
        end = match.end()
        punct_start = match.start()

        if end < len(buffer) and buffer[end - 1] != " " and end == len(buffer):
            # ainda não sabemos o que vem depois (pode ser decimal) — espera mais texto
            continue

        # Reticências: colapsa em um único ponto de corte, não corta no primeiro "."
        if match.group(1).startswith("..") or (
            punct_start > 0 and buffer[punct_start - 1] in ".!?"
        ):
            # se o próximo char depois do espaço também for pontuação, ainda não é o fim real
            pass

        # Não cortar em decimal: dígito imediatamente antes E depois do ponto (ex.: "3.5")
        if match.group(1) == "." and punct_start > 0 and buffer[punct_start - 1].isdigit():
            after = buffer[end:end + 1]
            if after.isdigit():
                continue

        # Não cortar em abreviação conhecida (ex.: "Sr.", "Dr.")
        if match.group(1) == ".":
            word_start = punct_start
            while word_start > 0 and (buffer[word_start - 1].isalnum()):
                word_start -= 1
            word = buffer[word_start:punct_start].lower()
            if word in _ABBREVIATIONS:
                continue

        candidate_len = len(buffer[:end].strip())
        if candidate_len < 15 and end < len(buffer):
            # frase curta demais e ainda há mais texto chegando — deixa acumular
            continue

        return end

    return None


# --- Detector de loop de repetição (achado fora do escopo da Fase 4, ver
# docs/implementation-phase-4.md e docs/fix-generation-repetition-loop-v2.md) ---

_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)


def _normalize_for_dedup(text: str) -> str:
    """Normaliza uma frase para comparação de repetição: minúsculas, só palavras, espaços únicos."""
    words = _WORD_RE.findall(text.lower())
    return " ".join(words)


def _is_near_duplicate_sentence(
    candidate: str, previously_emitted: list[str], threshold: float = 0.75
) -> bool:
    """
    True se `candidate` repete quase-verbatim (difflib.SequenceMatcher.ratio() >= threshold)
    alguma frase já emitida neste turno (`previously_emitted`, já normalizada). Frases com
    menos de 3 palavras nunca disparam — curtas demais para julgar com confiança sem risco de
    falso positivo em respostas curtas legítimas (a maioria do uso normal). SequenceMatcher (não
    Jaccard de trigramas, que falhava em variações no meio de frases longas — ver auditoria em
    docs/audits/fix-repetition-loop-audit-result-v1-agy.log) porque uma única palavra
    alterada/removida no meio de uma frase não deve derrubar artificialmente a pontuação.
    """
    candidate_norm = _normalize_for_dedup(candidate)
    if len(candidate_norm.split()) < 3:
        return False

    for prev_norm in previously_emitted:
        if len(prev_norm.split()) < 3:
            continue
        ratio = difflib.SequenceMatcher(None, candidate_norm, prev_norm).ratio()
        if ratio >= threshold:
            return True
    return False


# --- Estado de geração cancelável ---

@dataclass
class GenerationHandle:
    turn_id: str
    epoch: int
    cancel_event: threading.Event = field(default_factory=threading.Event)


class Worker:
    def __init__(self) -> None:
        self.work_queue: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=1)
        self._current: Optional[GenerationHandle] = None
        self._current_lock = threading.Lock()
        self._llm = None
        self._llm_tokenizer = None
        self._stt = None
        self._mx = None
        self._gemini_client = None  # lazy — ver handle_generate()
        self._genai = None

    # --- Carregamento de modelos (warmup) ---

    def load_models(self) -> None:
        import mlx.core as mx

        self._mx = mx
        mx.set_cache_limit(CACHE_LIMIT_BYTES)

        log_diag(f"Carregando LLM ({LLM_MODEL_ID})...")
        from mlx_lm import load as mlx_lm_load

        self._llm, self._llm_tokenizer = mlx_lm_load(LLM_MODEL_ID)
        log_diag("LLM carregado.")

        log_diag(f"Carregando STT ({STT_MODEL_ID})...")
        # mlx_whisper carrega o modelo sob demanda por chamada de transcribe(path_or_hf_repo=...);
        # fazemos uma chamada de aquecimento silenciosa não é viável sem áudio real, então
        # apenas confirmamos que o pacote importa e o repo é resolvível localmente.
        import mlx_whisper  # noqa: F401

        self._stt_model_id = STT_MODEL_ID
        log_diag("STT pronto (carregamento perezoso na primeira transcrição).")

        mx.clear_cache()
        emit({"event": "ready"})

    # --- Comandos ---

    def handle_cancel(self, msg: dict[str, Any]) -> None:
        turn_id = msg.get("turnId")
        with self._current_lock:
            current = self._current
            if current is not None and current.turn_id == turn_id:
                current.cancel_event.set()
        emit({"event": "cancelled", "turnId": turn_id})

    def handle_transcribe(self, msg: dict[str, Any]) -> None:
        req_id = msg["reqId"]
        audio_path = msg["audioPath"]
        try:
            import mlx_whisper

            result = mlx_whisper.transcribe(
                audio_path,
                path_or_hf_repo=self._stt_model_id,
                language="pt",
                fp16=True,
            )
            text = (result.get("text") or "").strip()
            emit({"event": "transcript", "reqId": req_id, "text": text})
        except Exception as exc:  # noqa: BLE001
            log_diag(f"Erro na transcrição: {exc}\n{traceback.format_exc()}")
            emit({"event": "error", "reqId": req_id, "message": "Falha ao transcrever áudio."})
        finally:
            if self._mx is not None:
                self._mx.clear_cache()

    def handle_classify(self, msg: dict[str, Any]) -> None:
        req_id = msg["reqId"]
        turn_id = msg["turnId"]
        epoch = msg["epoch"]
        text = msg["text"]

        # Achado v2-1 da auditoria: texto vazio/só espaço nunca vai pro LLM — o STT pode
        # devolver "" para ruído/fala inaudível que passou pelo VAD; sem essa checagem o
        # resultado da classificação fica imprevisível em vez de ser um erro técnico claro.
        if not text or not text.strip():
            emit({
                "event": "error", "reqId": req_id, "turnId": turn_id,
                "message": "Texto vazio para classificação."
            })
            return

        handle = GenerationHandle(turn_id=turn_id, epoch=epoch)
        with self._current_lock:
            self._current = handle

        try:
            messages = [
                {"role": "system", "content": CLASSIFICATION_SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ]
            prompt = self._llm_tokenizer.apply_chat_template(
                messages, add_generation_prompt=True, tokenize=False
            )

            from mlx_lm.generate import stream_generate
            from mlx_lm.sample_utils import make_sampler

            sampler = make_sampler(temp=0.0)  # determinístico — classificação, não geração criativa
            raw = ""
            for response in stream_generate(
                self._llm, self._llm_tokenizer, prompt, max_tokens=8, sampler=sampler
            ):
                if handle.cancel_event.is_set():
                    log_diag(f"Classificação cancelada pelo worker (turnId={turn_id}) — Node já resolveu localmente.")
                    return
                raw += response.text

            normalized = raw.strip().upper().strip(".!? \n")
            if normalized not in CLASSIFICATION_LABELS:
                log_diag(f"Saída de classificação fora do formato esperado (turnId={turn_id}).")
                emit({
                    "event": "error", "reqId": req_id, "turnId": turn_id,
                    "message": "Falha ao classificar: formato de saída inesperado."
                })
                return

            emit({"event": "classification", "reqId": req_id, "turnId": turn_id, "label": normalized})
        except Exception as exc:  # noqa: BLE001
            log_diag(f"Erro na classificação: {exc}\n{traceback.format_exc()}")
            emit({"event": "error", "reqId": req_id, "turnId": turn_id, "message": "Falha ao classificar a intenção."})
        finally:
            with self._current_lock:
                if self._current is handle:
                    self._current = None
            if self._mx is not None:
                self._mx.clear_cache()

    def handle_detect_tool(self, msg: dict[str, Any]) -> None:
        req_id = msg["reqId"]
        turn_id = msg["turnId"]
        epoch = msg["epoch"]
        text = msg["text"]

        if not text or not text.strip():
            emit({"event": "tool_detection", "reqId": req_id, "turnId": turn_id, "tool": "NENHUMA"})
            return

        handle = GenerationHandle(turn_id=turn_id, epoch=epoch)
        with self._current_lock:
            self._current = handle

        try:
            messages = [
                {"role": "system", "content": DETECT_TOOL_SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ]
            prompt = self._llm_tokenizer.apply_chat_template(
                messages, add_generation_prompt=True, tokenize=False
            )

            from mlx_lm.generate import stream_generate
            from mlx_lm.sample_utils import make_sampler

            sampler = make_sampler(temp=0.0)
            raw = ""
            for response in stream_generate(
                self._llm, self._llm_tokenizer, prompt, max_tokens=6, sampler=sampler
            ):
                if handle.cancel_event.is_set():
                    log_diag(f"Detecção de ferramenta cancelada pelo worker (turnId={turn_id}).")
                    return
                raw += response.text

            tool = parse_tool_output(raw)
            emit({"event": "tool_detection", "reqId": req_id, "turnId": turn_id, "tool": tool})
        except Exception as exc:  # noqa: BLE001
            log_diag(f"Erro na detecção de ferramenta: {exc}\n{traceback.format_exc()}")
            emit({"event": "error", "reqId": req_id, "turnId": turn_id, "message": "Falha ao detectar ferramenta."})
        finally:
            with self._current_lock:
                if self._current is handle:
                    self._current = None
            if self._mx is not None:
                self._mx.clear_cache()

    def handle_detect_mutation(self, msg: dict[str, Any]) -> None:
        req_id = msg["reqId"]
        turn_id = msg["turnId"]
        epoch = msg["epoch"]
        text = msg["text"]

        if not text or not text.strip():
            emit({"event": "mutation_detection", "reqId": req_id, "turnId": turn_id, "action": "NENHUMA", "content": None})
            return

        handle = GenerationHandle(turn_id=turn_id, epoch=epoch)
        with self._current_lock:
            self._current = handle

        try:
            from mlx_lm.generate import stream_generate
            from mlx_lm.sample_utils import make_sampler

            def run(system: str, user: str, max_tokens: int):
                """Uma geração greedy; devolve (texto, truncado) ou None se cancelada."""
                messages = [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ]
                prompt = self._llm_tokenizer.apply_chat_template(
                    messages, add_generation_prompt=True, tokenize=False
                )
                sampler = make_sampler(temp=0.0)
                out = ""
                count = 0
                for response in stream_generate(
                    self._llm, self._llm_tokenizer, prompt, max_tokens=max_tokens, sampler=sampler
                ):
                    if handle.cancel_event.is_set():
                        log_diag(f"Detecção de mutação cancelada pelo worker (turnId={turn_id}).")
                        return None
                    out += response.text
                    count += 1
                return out, count >= max_tokens

            first = run(DETECT_MUTATION_SYSTEM_PROMPT, text, 96)
            if first is None:
                return
            raw, truncated = first
            action, content = parse_mutation_output(raw, truncated=truncated)


            emit({
                "event": "mutation_detection",
                "reqId": req_id,
                "turnId": turn_id,
                "action": action,
                "content": content,
            })
        except Exception as exc:  # noqa: BLE001
            log_diag(f"Erro na detecção de mutação: {exc}\n{traceback.format_exc()}")
            emit({"event": "error", "reqId": req_id, "turnId": turn_id, "message": "Falha ao detectar mutação."})
        finally:
            with self._current_lock:
                if self._current is handle:
                    self._current = None
            if self._mx is not None:
                self._mx.clear_cache()

    def handle_detect_confirmation(self, msg: dict[str, Any]) -> None:
        req_id = msg["reqId"]
        turn_id = msg["turnId"]
        epoch = msg["epoch"]
        text = msg["text"]

        if not text or not text.strip():
            emit({"event": "confirmation_detection", "reqId": req_id, "turnId": turn_id, "confirmation": "NAO"})
            return

        handle = GenerationHandle(turn_id=turn_id, epoch=epoch)
        with self._current_lock:
            self._current = handle

        try:
            messages = [
                {"role": "system", "content": DETECT_CONFIRMATION_SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ]
            prompt = self._llm_tokenizer.apply_chat_template(
                messages, add_generation_prompt=True, tokenize=False
            )

            from mlx_lm.generate import stream_generate
            from mlx_lm.sample_utils import make_sampler

            sampler = make_sampler(temp=0.0)
            raw = ""
            for response in stream_generate(
                self._llm, self._llm_tokenizer, prompt, max_tokens=6, sampler=sampler
            ):
                if handle.cancel_event.is_set():
                    log_diag(f"Detecção de confirmação cancelada pelo worker (turnId={turn_id}).")
                    return
                raw += response.text

            confirmation = parse_confirmation_output(raw)
            emit({
                "event": "confirmation_detection",
                "reqId": req_id,
                "turnId": turn_id,
                "confirmation": confirmation,
            })
        except Exception as exc:  # noqa: BLE001
            log_diag(f"Erro na detecção de confirmação: {exc}\n{traceback.format_exc()}")
            emit({"event": "error", "reqId": req_id, "turnId": turn_id, "message": "Falha ao detectar confirmação."})
        finally:
            with self._current_lock:
                if self._current is handle:
                    self._current = None
            if self._mx is not None:
                self._mx.clear_cache()

    def handle_generate(self, msg: dict[str, Any]) -> None:
        req_id = msg["reqId"]
        turn_id = msg["turnId"]
        epoch = msg["epoch"]
        messages = msg["messages"]

        handle = GenerationHandle(turn_id=turn_id, epoch=epoch)
        with self._current_lock:
            self._current = handle

        try:
            if not os.environ.get("GEMINI_API_KEY"):
                raise RuntimeError("GEMINI_API_KEY ausente — configure a variável de ambiente.")

            if self._gemini_client is None:
                # Achado CRÍTICA reaberto (rodada 2): import e construção tardios — nunca no
                # __init__ nem no topo do módulo (o mesmo padrão de lazy import que mlx.core/mlx_lm
                # já seguem hoje, achado novo BAIXA da rodada 2 também cobre isso). Se a chave
                # estiver ausente, o RuntimeError acima já interrompeu antes de chegar aqui — o
                # cliente nunca é construído com api_key vazia.
                from google import genai
                self._genai = genai
                self._gemini_client = genai.Client(
                    api_key=os.environ["GEMINI_API_KEY"],
                    http_options=genai.types.HttpOptions(timeout=20_000),  # 20s — bem abaixo do
                    # timeout de 60s do Node (VOICE_LIMITS.TURN_TIMEOUT_MS), pra que uma falha de
                    # rede emita "error" NDJSON e libere o turno, em vez de deixar o Node matar o
                    # worker inteiro com SIGKILL por uma causa que não é travamento de GPU.
                )
            else:
                genai = self._genai

            system_instruction, contents = to_gemini_contents(messages)

            buffer = ""
            sentence_index = 0
            emitted_normalized: list[str] = []
            loop_detected = False

            stream = self._gemini_client.models.generate_content_stream(
                model="gemini-flash-latest",
                contents=contents,
                config=genai.types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    max_output_tokens=MAX_TURN_TOKENS,  # Achado ALTA novo (rodada 2) — ver abaixo
                ),
            )

            gemini_call_started = time.monotonic()
            first_chunk_logged = False
            for chunk in stream:
                if not first_chunk_logged:
                    log_diag(f"Gemini TTFC: {time.monotonic() - gemini_call_started:.2f}s (turnId={turn_id})")
                    first_chunk_logged = True

                if handle.cancel_event.is_set():
                    log_diag(f"Geração cancelada (turnId={turn_id}) — parando de consumir o stream do Gemini.")
                    break  # achado 3 (rodada 1) — sem stream.close(), método inexistente no SDK

                buffer += chunk.text or ""

                # EXATAMENTE o mesmo laço de find_sentence_boundary/emit/dedupe já existente e
                # testado — reaproveitado sem mudança, só a origem de `buffer` mudou:
                boundary = find_sentence_boundary(buffer)
                while boundary is not None:
                    sentence = buffer[:boundary].strip()
                    buffer = buffer[boundary:]
                    if sentence:
                        if _is_near_duplicate_sentence(sentence, emitted_normalized):
                            log_diag(
                                f"Loop de repetição detectado (turnId={turn_id}, "
                                f"frase {sentence_index}) — encerrando geração aqui."
                            )
                            loop_detected = True
                            break
                        emit({
                            "event": "sentence",
                            "reqId": req_id,
                            "turnId": turn_id,
                            "index": sentence_index,
                            "text": sentence,
                        })
                        emitted_normalized.append(_normalize_for_dedup(sentence))
                        sentence_index += 1
                    boundary = find_sentence_boundary(buffer)
                if loop_detected:
                    break

            if not handle.cancel_event.is_set():
                # Achado 2 (CRÍTICA, rodada 1): "done" é emitido INCONDICIONALMENTE aqui — um loop
                # detectado é fim natural da resposta, mesma semântica do código local hoje
                # (worker.py:699-713), não uma falha que deveria travar o protocolo NDJSON.
                if not loop_detected:
                    leftover = buffer.strip()
                    if leftover and not _is_near_duplicate_sentence(leftover, emitted_normalized):
                        emit({
                            "event": "sentence",
                            "reqId": req_id,
                            "turnId": turn_id,
                            "index": sentence_index,
                            "text": leftover,
                        })
                emit({"event": "done", "reqId": req_id, "turnId": turn_id})

        except Exception as exc:  # noqa: BLE001 — chave ausente, timeout de rede (20s, acima),
                                    # erro de cota/API do Gemini, ValueError de to_gemini_contents —
                                    # todos tratados igual: erro honesto
            log_diag(f"Erro na geração via Gemini: {exc}\n{traceback.format_exc()}")
            emit({
                "event": "error",
                "reqId": req_id,
                "turnId": turn_id,
                "message": "Falha ao gerar resposta via Gemini.",
            })
        finally:
            with self._current_lock:
                if self._current is handle:
                    self._current = None

    # --- Loop de trabalho (thread principal) ---

    def work_loop(self) -> None:
        while True:
            msg = self.work_queue.get()
            cmd = msg.get("cmd")
            try:
                if cmd == "transcribe":
                    self.handle_transcribe(msg)
                elif cmd == "classify":
                    self.handle_classify(msg)
                elif cmd == "detect_tool":
                    self.handle_detect_tool(msg)
                elif cmd == "detect_mutation":
                    self.handle_detect_mutation(msg)
                elif cmd == "detect_confirmation":
                    self.handle_detect_confirmation(msg)
                elif cmd == "generate":
                    self.handle_generate(msg)
            except Exception as exc:  # noqa: BLE001
                log_diag(f"Erro não tratado no work_loop: {exc}\n{traceback.format_exc()}")
                emit({"event": "error", "message": "Falha interna do worker."})

    # --- Thread leitora de stdin (dedicada, nunca bloqueia em inferência) ---

    def stdin_reader_loop(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                log_diag("Linha stdin inválida (não é JSON) — ignorada.")
                continue

            cmd = msg.get("cmd")
            if cmd == "cancel":
                self.handle_cancel(msg)
            elif cmd == "ping":
                emit({"event": "pong"})
            elif cmd in ("transcribe", "classify", "generate", "detect_tool", "detect_mutation", "detect_confirmation"):
                # Fila de tamanho 1: se algo estiver esperando (não deveria, pois o Node só
                # envia um novo comando após cancelar o anterior), descarta o mais antigo.
                try:
                    self.work_queue.put_nowait(msg)
                except queue.Full:
                    try:
                        self.work_queue.get_nowait()
                    except queue.Empty:
                        pass
                    self.work_queue.put_nowait(msg)
            else:
                log_diag(f"Comando desconhecido ignorado: {cmd!r}")

        # stdin fechado (Node encerrou) — sai limpo.
        log_diag("stdin fechado — encerrando worker.")
        os._exit(0)


def main() -> None:
    worker = Worker()

    reader_thread = threading.Thread(target=worker.stdin_reader_loop, daemon=True)
    reader_thread.start()

    start = time.monotonic()
    try:
        worker.load_models()
    except Exception as exc:  # noqa: BLE001
        log_diag(f"Falha catastrófica ao carregar modelos: {exc}\n{traceback.format_exc()}")
        emit({"event": "error", "message": "Falha ao inicializar modelos locais."})
        sys.exit(1)

    log_diag(f"Aquecimento concluído em {time.monotonic() - start:.1f}s.")
    worker.work_loop()


if __name__ == "__main__":
    main()
