import sys, json
from urllib.parse import urlparse
def naive(u):  # leitura literal do plano: "host é loopback"
    try: h = urlparse(u).hostname
    except Exception: return False
    return h in ("127.0.0.1","localhost","::1")
def strict(u):
    from urllib.parse import urlsplit
    try: p = urlsplit(u)
    except Exception: return False
    return (p.scheme in ("http","https") and p.username is None and p.password is None
            and p.hostname in ("127.0.0.1","::1") and "\\" not in u and " " not in u)
P=["http://127.0.0.1:9000","http://localhost:9000","http://[::1]:9000","http://127.0.0.1@evil.com/","http://evil.com\\@127.0.0.1/",
"http://127.0.0.1.evil.com/","http://localhost.evil.com/","http://0.0.0.0:9000","http://127.0.0.2:9000","http://[::ffff:127.0.0.1]:9000",
"http://[0:0:0:0:0:0:0:1]:9000","http://0x7f.1/","http://2130706433/","http://017700000001/","file:///etc/passwd","HTTP://LOCALHOST:9000",
"http://127.1/","http://127.0.0.1:9000@evil.com/","http://evil.com#@127.0.0.1/","http://evil.com?@127.0.0.1/","http://user:pw@127.0.0.1/",
"http://LOCALHOST./","http://localhost@evil.com/","http://127.0.0.1\t.evil.com/","http://[::1]@evil.com/"]
print(json.dumps([[u,naive(u),strict(u)] for u in P]))
