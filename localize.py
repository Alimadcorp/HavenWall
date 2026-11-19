import json
import mimetypes
import os
import re
import shutil
from pathlib import Path
from urllib.parse import urlparse, unquote, quote
import requests
from bs4 import BeautifulSoup

# You'd have to run pip install beautifulsoup4 requests for this

HTML_FILE = "index.html"
JSON_FILE = "games.json"
ASSETS_DIR = "assets"
PROXY_BASE = "https://proxy.alimad.co/api/proxy?url="

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
}

def get_base_local_path(url: str) -> Path:
    parsed = urlparse(url)
    clean_path = unquote(parsed.path).lstrip("/")
    
    if not clean_path or clean_path.endswith("/"):
        clean_path += "index"
        
    domain = parsed.netloc.replace(":", "_")
    return Path(ASSETS_DIR) / domain / clean_path

def resolve_existing_file(base_path: Path) -> Path | None:
    if base_path.exists() and base_path.is_file():
        return base_path
    if base_path.parent.exists():
        for existing in base_path.parent.iterdir():
            if existing.stem == base_path.name and existing.is_file():
                return existing
    return None

def download_via_proxy(target_url: str) -> str | None:
    base_path = get_base_local_path(target_url)
    
    existing = resolve_existing_file(base_path)
    if existing:
        return existing.as_posix()

    proxy_url = f"{PROXY_BASE}{quote(target_url, safe='')}"
    
    try:
        response = requests.get(proxy_url, headers=HEADERS, timeout=20, stream=True)
        response.raise_for_status()

        dest_path = base_path
        if not dest_path.suffix:
            content_type = response.headers.get("Content-Type", "").split(";")[0].strip()
            ext = mimetypes.guess_extension(content_type) or ".png"
            if ext == ".jpe":
                ext = ".jpg"
            dest_path = dest_path.with_suffix(ext)

        dest_path.parent.mkdir(parents=True, exist_ok=True)
        with open(dest_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)

        print(f"[OK] {target_url} -> {dest_path.as_posix()}")
        return dest_path.as_posix()
    except Exception as e:
        print(f"[ERR] Failed {target_url}: {e}")
        return None

def process_url(raw_url: str) -> str:
    if not isinstance(raw_url, str):
        return raw_url

    raw_url = raw_url.strip()
    if not raw_url or raw_url.startswith(("data:", "blob:")):
        return raw_url

    fetch_url = f"https:{raw_url}" if raw_url.startswith("//") else raw_url

    if not fetch_url.startswith(("http://", "https://")):
        return raw_url

    if fetch_url.startswith(PROXY_BASE):
        fetch_url = unquote(fetch_url[len(PROXY_BASE):])

    local_path = download_via_proxy(fetch_url)
    return local_path if local_path else raw_url

def process_html():
    if not os.path.exists(HTML_FILE):
        print(f"[SKIP] '{HTML_FILE}' not found.")
        return

    shutil.copyfile(HTML_FILE, f"{HTML_FILE}.bak")
    with open(HTML_FILE, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f.read(), "html.parser")

    for tag in soup.find_all(["img", "source", "input"]):
        if tag.has_attr("src"):
            tag["src"] = process_url(tag["src"])

        if tag.has_attr("srcset"):
            new_srcset = []
            for item in tag["srcset"].split(","):
                parts = item.strip().split()
                if parts:
                    parts[0] = process_url(parts[0])
                    new_srcset.append(" ".join(parts))
            tag["srcset"] = ", ".join(new_srcset)

    url_pattern = re.compile(r'url\((["\']?)(.*?)\1\)')
    for tag in soup.find_all(style=True):
        def replace_css_url(match):
            quote_char, url = match.group(1), match.group(2)
            return f"url({quote_char}{process_url(url)}{quote_char})"

        tag["style"] = url_pattern.sub(replace_css_url, tag["style"])

    with open(HTML_FILE, "w", encoding="utf-8") as f:
        f.write(str(soup))
    print(f"[DONE] Updated '{HTML_FILE}' (backup saved to '{HTML_FILE}.bak')")

def process_json():
    if not os.path.exists(JSON_FILE):
        print(f"[SKIP] '{JSON_FILE}' not found.")
        return

    shutil.copyfile(JSON_FILE, f"{JSON_FILE}.bak")
    with open(JSON_FILE, "r", encoding="utf-8") as f:
        games = json.load(f)

    for entry in games:
        if isinstance(entry, dict) and "gamePhoto" in entry and entry["gamePhoto"]:
            entry["gamePhoto"] = process_url(entry["gamePhoto"])

    with open(JSON_FILE, "w", encoding="utf-8") as f:
        json.dump(games, f, indent=2, ensure_ascii=False)
    print(f"[DONE] Updated '{JSON_FILE}' (backup saved to '{JSON_FILE}.bak')")

if __name__ == "__main__":
    process_html()
    process_json()
