"""Peran AI: siapa yang meriset, menulis draf, menjuri, dan mengecek fakta untuk tiap channel konten.

Diatur dari dashboard (tab Otomasi → Peran AI) dan disimpan di ~/.config/gitgit-studio/peran-ai.json; pipeline
(gitgit_standup, nostalgia-reels, whatif-automation) memanggil ask_json(channel, peran, ...) dan membaca pengaturan
itu setiap kali, jadi perubahan langsung berlaku tanpa restart. AI pilihan yang gagal (limit, error, balasan bukan
JSON) digantikan bawaan peran itu, dan nama AI yang benar-benar menjawab ikut dikembalikan untuk log & dashboard.

    from peran_ai import ask_json
    data, siapa = ask_json("standup", "juri", system, user)
"""
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

CONFIG = Path(os.getenv("PERAN_AI_FILE", Path.home() / ".config" / "gitgit-studio" / "peran-ai.json"))
CHANNELS = ("standup", "kaiara", "whatif")
DEFAULTS = {"riset": "claude:sonnet", "penulis": "claude:sonnet", "juri": "claude:opus", "cek": "claude:opus"}
CHOICES = ("claude:sonnet", "claude:opus", "mimo:pro", "mimo:flash", "hermes")
MIMO_MODELS = {"pro": "mimo-v2.6-pro", "flash": "mimo-v2.6-flash"}
DASHBOARD_ENV = Path(__file__).resolve().parent.parent / ".env"  # MIMO_API_KEY / MIMO_BASE_URL dashboard
CLAUDE = Path.home() / ".local" / "bin" / "claude"
HERMES = Path.home() / ".local" / "bin" / "hermes"
SCRATCH = Path.home() / ".cache" / "peran-ai"  # cwd Claude: jangan ikut memuat CLAUDE.md repo mana pun
USAGE_FILE = Path.home() / ".config" / "gitgit-studio" / "mimo-usage.jsonl"


def log(*a):
    print(time.strftime("[%H:%M:%S]"), "peran-ai:", *a, flush=True)


def settings():
    """{channel: {peran: pilihan}} lengkap dengan bawaan untuk yang belum diatur."""
    try:
        saved = json.loads(CONFIG.read_text())
    except (OSError, ValueError):
        saved = {}
    return {ch: {r: (saved.get(ch, {}).get(r) if saved.get(ch, {}).get(r) in CHOICES else d) for r, d in DEFAULTS.items()} for ch in CHANNELS}


def _env(key):
    if os.getenv(key):
        return os.environ[key]
    try:
        for line in DASHBOARD_ENV.read_text().splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def _claude(model, system, user, web, timeout):
    SCRATCH.mkdir(parents=True, exist_ok=True)
    tools = "WebSearch,WebFetch" if web else ""
    args = [str(CLAUDE), "-p", "--output-format", "text", "--model", model, "--tools", tools, "--strict-mcp-config",
            "--setting-sources", "", "--no-session-persistence", "--system-prompt", system]
    if web:
        args += ["--allowedTools", tools]
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_CODE") and k != "CLAUDECODE"}
    r = subprocess.run(args, input=user, capture_output=True, text=True, cwd=SCRATCH, timeout=timeout, env=env)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"claude {model}: {(r.stderr or r.stdout).strip()[:300]}")
    return r.stdout


def _mimo(model, system, user, timeout):
    """MiMo Token Plan (tanpa web search). Pemakaian token dicatat ke statistik MiMo dashboard."""
    base = (_env("MIMO_BASE_URL") or "https://token-plan-sgp.xiaomimimo.com/v1").rstrip("/")
    name = MIMO_MODELS[model]
    body = json.dumps({"model": name, "temperature": 0.7, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}).encode()
    req = urllib.request.Request(f"{base}/chat/completions", data=body, headers={"Authorization": f"Bearer {_env('MIMO_API_KEY')}", "Content-Type": "application/json"})
    try:
        res = json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"MiMo {name}: {e.code} {e.read()[:200]!r}") from e
    u = res.get("usage") or {}
    try:
        with open(USAGE_FILE, "a") as f:
            f.write(json.dumps({"t": int(time.time() * 1000), "source": "peran-ai", "model": name, "in": u.get("prompt_tokens", 0),
                                "out": u.get("completion_tokens", 0), "cached": (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0),
                                "reasoning": (u.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)}) + "\n")
    except OSError:
        pass
    return res["choices"][0]["message"]["content"]


def _hermes(system, user, timeout):
    """Agen Hermes sekali jalan (tool-nya sendiri, termasuk web), memakai model yang dipilih di config Hermes."""
    r = subprocess.run([str(HERMES), "-z", f"{system}\n\n---\n\n{user}"], capture_output=True, text=True, cwd=SCRATCH, timeout=timeout)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"hermes: {(r.stderr or r.stdout).strip()[:300]}")
    return r.stdout


def call(choice, system, user, web=False, timeout=900):
    """Teks jawaban dari satu pilihan AI ("claude:opus", "mimo:pro", "hermes", ...)."""
    kind, _, model = choice.partition(":")
    if kind == "claude":
        return _claude(model, system, user, web, timeout)
    if kind == "mimo":
        return _mimo(model, system, user, timeout)
    if kind == "hermes":
        SCRATCH.mkdir(parents=True, exist_ok=True)
        return _hermes(system, user, timeout)
    raise ValueError(f"pilihan AI tidak dikenal: {choice}")


def parse_json(text):
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError(f"bukan JSON: {text[:200]!r}")
    return json.loads(text[start:end + 1])


def ask_json(channel, role, system, user, web=False, timeout=900):
    """(jawaban JSON, pilihan AI yang menjawab): pilihan dashboard, lalu bawaan peran itu, lalu Claude Sonnet."""
    chosen = settings().get(channel, DEFAULTS).get(role, DEFAULTS[role])
    order = list(dict.fromkeys([chosen, DEFAULTS[role], "claude:sonnet"]))  # Sonnet terakhir: Opus pun bisa kena limit
    err = None
    for choice in order:
        try:
            return parse_json(call(choice, system, user, web, timeout)), choice
        except Exception as e:  # noqa: BLE001 - coba bawaan peran ini
            err = e
            log(f"{channel}/{role} {choice} gagal: {str(e)[:200]}")
    raise RuntimeError(f"{channel}/{role}: semua AI gagal ({err})")


if __name__ == "__main__":  # self-check tanpa memanggil AI sungguhan
    import tempfile

    CONFIG = Path(tempfile.mkdtemp()) / "peran.json"
    assert settings()["whatif"]["juri"] == "claude:opus"
    CONFIG.write_text(json.dumps({"standup": {"juri": "mimo:pro", "riset": "ngawur"}}))
    s = settings()
    assert s["standup"]["juri"] == "mimo:pro" and s["standup"]["riset"] == "claude:sonnet" and s["kaiara"]["juri"] == "claude:opus"
    seen = []

    def fake(choice, system, user, web=False, timeout=0):
        seen.append(choice)
        if choice == "mimo:pro":
            raise RuntimeError("limit")
        return 'teks pembuka {"nilai": [9, 7]} penutup'

    call = fake
    data, who = ask_json("standup", "juri", "s", "u")
    assert data == {"nilai": [9, 7]} and who == "claude:opus" and seen == ["mimo:pro", "claude:opus"]
    seen.clear()

    def opus_limit(choice, system, user, web=False, timeout=0):
        seen.append(choice)
        if choice != "claude:sonnet":
            raise RuntimeError("limit mingguan")
        return '{"nilai": [1]}'

    call = opus_limit
    assert ask_json("standup", "juri", "s", "u")[1] == "claude:sonnet" and seen == ["mimo:pro", "claude:opus", "claude:sonnet"]
    call = fake
    seen.clear()
    data, who = ask_json("kaiara", "juri", "s", "u")
    assert who == "claude:opus" and seen == ["claude:opus"]
    print("ok")
