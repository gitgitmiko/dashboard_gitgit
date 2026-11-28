"""Catatan setiap kali produksi konten memakai cadangan (AI pengganti, bank naskah, suara Piper, stok video).

Semua kejadian masuk ~/.config/gitgit-studio/cadangan.jsonl, yang ditampilkan dashboard (tab Otomasi → Riwayat
cadangan). Kejadian darurat juga dikirim ke grup WhatsApp lewat `hermes send`, paling banyak sekali per 6 jam untuk
jenis + channel yang sama. Tidak pernah melempar error: pencatatan tidak boleh menggagalkan produksi.

    from cadangan import catat
    catat("standup", "bank-naskah", "AI gagal menulis, pakai naskah 'Parkir Seikhlasnya'", darurat=True)
"""
import json
import os
import subprocess
import time
from pathlib import Path

LOG = Path(os.getenv("CADANGAN_LOG", Path.home() / ".config" / "gitgit-studio" / "cadangan.jsonl"))
HERMES = os.getenv("HERMES_BIN", str(Path.home() / ".hermes" / "hermes-agent" / ".hermes" / "bin" / "hermes"))
WA_ENV = Path.home() / "github-repos" / "cctv-stack" / "notifier" / "notifier.env"  # WA_TARGET grup yang sama dengan CCTV
WA_JEDA = 6 * 3600
NAMA = {"standup": "Gitgit Stand-up", "kaiara": "Kai & Kak Ara", "whatif": "GIMANA JADINYA?"}


def _wa_target():
    if os.getenv("WA_TARGET"):
        return os.environ["WA_TARGET"]
    try:
        for line in WA_ENV.read_text().splitlines():
            if line.startswith("WA_TARGET="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def _baru_dikirim(channel, jenis, now):
    """Sudah ada WA untuk channel + jenis ini dalam WA_JEDA terakhir?"""
    try:
        for line in reversed(LOG.read_text().splitlines()[-500:]):
            e = json.loads(line)
            if now - e["t"] / 1000 > WA_JEDA:
                return False
            if e.get("wa") and e["channel"] == channel and e["jenis"] == jenis:
                return True
    except (OSError, ValueError, KeyError):
        pass
    return False


def catat(channel, jenis, pesan, darurat=False):
    now = time.time()
    wa = False
    try:
        if darurat and not _baru_dikirim(channel, jenis, now) and (target := _wa_target()):
            body = f"⚠️ Mode cadangan {NAMA.get(channel, channel)}: {pesan}"
            wa = subprocess.run([HERMES, "send", "--to", target, body], capture_output=True, timeout=90).returncode == 0
    except Exception:  # noqa: BLE001 - WA gagal tetap dicatat di dashboard
        pass
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a") as f:
            f.write(json.dumps({"t": int(now * 1000), "channel": channel, "jenis": jenis, "pesan": pesan[:500],
                                "darurat": darurat, "wa": wa}, ensure_ascii=False) + "\n")
    except OSError:
        pass
    print(time.strftime("[%H:%M:%S]"), f"cadangan {channel}/{jenis}:", pesan, "(WA terkirim)" if wa else "", flush=True)


if __name__ == "__main__":  # self-check tanpa WA sungguhan
    import tempfile

    LOG = Path(tempfile.mkdtemp()) / "c.jsonl"
    sent = []
    subprocess.run = lambda args, **kw: (sent.append(args[-1]), type("R", (), {"returncode": 0})())[1]
    os.environ["WA_TARGET"] = "whatsapp:tes@g.us"
    catat("whatif", "ai", "Claude gagal, dijawab MiMo")              # bukan darurat: tanpa WA
    catat("whatif", "suara-piper", "suara darurat Piper", darurat=True)
    catat("whatif", "suara-piper", "suara darurat Piper lagi", darurat=True)  # dalam 6 jam: tanpa WA
    catat("kaiara", "suara-piper", "jenis sama, channel lain", darurat=True)
    rows = [json.loads(l) for l in LOG.read_text().splitlines()]
    assert [r["wa"] for r in rows] == [False, True, False, True] and len(sent) == 2, rows
    print("ok")
