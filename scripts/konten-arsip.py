#!/usr/bin/env python3
"""Copies every finished piece of content into files.gitgitmiko.my.id (File Browser serves /mnt/data/share),
under "Konten Automation Sigit", sorted by channel. Runs hourly from cron; files already there are skipped, so it
only ever adds. The production folders keep their originals (the pipelines and posting still read them).

    python3 scripts/konten-arsip.py [--dry-run]
"""
import json
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path

HOME = Path.home()
REPOS = HOME / "github-repos"
DEST = Path("/mnt/data/share/Konten Automation Sigit")
YT = DEST / "1. YouTube - Gimana Jadinya"
GITGIT = DEST / "4. Gitgit - Stand-up Comedy"
IG = DEST / "2. Instagram - GitGit InfoGame"
FB = DEST / "3. Facebook - Kai & Kak Ara"
ARSIP = DEST / "9. Arsip (Tidak Aktif)"
DRY = "--dry-run" in sys.argv
copied = []


def safe(name, limit=110):
    """A file name that also works when the share is opened from Windows."""
    name = re.sub(r'[\\/:*?"<>|]+', "", name).strip().rstrip(".")
    return re.sub(r"\s+", " ", name)[:limit].strip() or "tanpa judul"


def put(src: Path, dst: Path):
    if not src.exists() or (dst.exists() and dst.stat().st_size == src.stat().st_size):
        return
    copied.append(str(dst.relative_to(DEST)))
    if DRY:
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".part")
    shutil.copy2(src, tmp)
    tmp.replace(dst)


def load(p):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, ValueError):
        return {}


def gimana_jadinya():
    runs = REPOS / "whatif-automation" / "runs"
    for d in sorted(runs.glob("2026*-*-*")):
        m = re.fullmatch(r"(\d{4})(\d\d)(\d\d)-(pagi|sore|malam)-\w+", d.name)
        if not m or not (d / "final.mp4").exists():
            continue
        s = load(d / "script.json")
        title = s.get("yt_title") or s.get("title") or d.name
        mode = " (horor)" if s.get("mode") == "horor" else ""
        put(d / "final.mp4", YT / "Video" / f"{m[1]}-{m[2]}" / (safe(f"{m[1]}-{m[2]}-{m[3]} {m[4]}{mode} - {title}") + ".mp4"))
    for name in ("test-atc-v2", "test-horor-01", "test-profesi-kasir"):
        put(runs / name / "final.mp4", YT / "Uji Coba" / f"{name}.mp4")
    ch = REPOS / "whatif-automation" / "assets" / "channel"
    for f in ("banner.jpg", "profile.png", "watermark.png", "gimanajadinya.md"):
        put(ch / f, YT / "Channel Art" / f)


def infogame():
    media = REPOS / "n8n" / "media" / "public" / "social"
    for f in sorted((media / "game").glob("*/*")):
        if f.suffix.lower() in (".jpg", ".png", ".mp4"):
            put(f, IG / "Postingan" / f.parent.name / f.name)
    # accounts that no longer post: their images are kept, under the archive
    for key, label in (("politik", "InfoPol"), ("crypto", "InfoCrypto"), ("saham", "InfoSaham")):
        for f in sorted((media / key).glob("*/*")):
            if f.suffix.lower() in (".jpg", ".png", ".mp4"):
                put(f, ARSIP / f"Instagram - GitGit {label}" / f.parent.name / f.name)


def kai_ara():
    root = REPOS / "nostalgia-reels"
    for d in sorted((root / "runs").glob("2026*-*-*")):
        m = re.fullmatch(r"(\d{4})(\d\d)(\d\d)-(duo|stick)-.+", d.name)
        if not m or not (d / "final.mp4").exists():
            continue
        s = load(d / "script.json")
        fmt = "stickman" if m[4] == "stick" else "format lama"
        put(d / "final.mp4", FB / "Video" / f"{m[1]}-{m[2]}" / (safe(f"{m[1]}-{m[2]}-{m[3]} - {s.get('judul') or d.name} ({fmt})") + ".mp4"))
    put(root / "runs" / "stick-proto" / "final-stick.mp4", FB / "Uji Coba" / "purwarupa-stickman-celengan.mp4")
    for f in (root / "characters" / "stick").glob("*.*"):
        if f.name != "banner-bg.jpg":
            put(f, FB / "Halaman (Foto Profil & Banner)" / "Stickman (baru)" / f.name)


def gitgit_standup():
    """Videos from the gitgit_standup pipeline (one per day, the outbox is the source of truth) + the channel art."""
    root = REPOS / "gitgit_standup"
    for f in ("banner.jpg", "profile.png", "watermark.png", "gitgit-standup.md"):
        put(root / "assets" / "channel" / f, GITGIT / "Channel Art" / f)
    for f in sorted((root / "data" / "outbox").glob("*.json")):
        it = load(f)
        video = Path(it["video"]) if it.get("video") else None
        if not it.get("judul") or not video or not video.exists():
            continue
        day = (it.get("created") or "")[:10] or time.strftime("%Y-%m-%d", time.localtime(video.stat().st_mtime))
        base = safe(f"{day} - {it['judul']}")
        put(video, GITGIT / "Video" / day[:7] / (base + ".mp4"))
        thumb = Path(it["thumbnail"]) if it.get("thumbnail") else None
        if thumb and thumb.exists():
            put(thumb, GITGIT / "Video" / day[:7] / (base + ".jpg"))


def parodi():
    runs = REPOS / "parodi-anime" / "runs"
    for d in sorted(runs.glob("*-ep[0-9][0-9]")):
        if (d / "final.mp4").exists():
            s = load(d / "script.json")
            series, ep = d.name.rsplit("-ep", 1)
            put(d / "final.mp4", ARSIP / "Parodi Anime" / series.title() /
                (safe(f"{series.title()} Part {int(ep)} - {s.get('part_title') or ''}".rstrip(" -")) + ".mp4"))


if __name__ == "__main__":
    for step in (gimana_jadinya, infogame, kai_ara, gitgit_standup, parodi):
        try:
            step()
        except Exception as e:  # noqa: BLE001 - one channel failing must not stop the others
            print(f"{step.__name__}: {e}", file=sys.stderr)
    print(f"{'akan disalin' if DRY else 'disalin'}: {len(copied)} file")
    for c in copied[:15]:
        print("  ", c)
