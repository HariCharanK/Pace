"""Corpus ingestion: RSS feeds, single pages, Wikipedia knowledge bytes, Gutenberg book excerpts.

Usage:
  uv run python ingest.py            # refresh everything in sources.json
  uv run python ingest.py feeds      # only feeds (or: pages, wikipedia, books)
"""
import hashlib
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import feedparser
import httpx
import textstat
import trafilatura

import db

ROOT = Path(__file__).parent
SOURCES = ROOT / "sources.json"
CACHE = db.DATA / "cache"

UAS = {
    "default": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    "googlebot": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
}
WIKI_UA = "speedreader-personal/0.1 (personal reading practice tool)"

MIN_WORDS = 450
MAX_WORDS = 2300
MIN_FLESCH = 25  # skip very dense prose

BOILERPLATE = re.compile(
    r"^(advertisement|skip advertisement|supported by|credit\b|photo|image|read more|related:|subscribe|sign up|"
    r"share this|this article is republished|the conversation|listen to this article|follow .* on|"
    r"we want to hear|thank you for your patience|you can now listen|leer en español|"
    r"if you enjoyed this|want more|join \d|get the|click here)",
    re.I,
)

SKIP_WIKI_SECTIONS = {"see also", "references", "notes", "further reading", "external links", "bibliography",
                      "sources", "citations", "footnotes", "gallery", "works cited", "explanatory notes"}


# ---------------------------------------------------------------- helpers

def pid(key: str) -> str:
    return hashlib.sha1(key.encode()).hexdigest()[:12]


def http_get(url: str, ua: str = "default", timeout: float = 25) -> httpx.Response:
    headers = {"User-Agent": UAS.get(ua, ua), "Accept-Language": "en-US,en;q=0.9"}
    return httpx.get(url, headers=headers, follow_redirects=True, timeout=timeout)


def clean_paragraphs(text: str, title: str = "") -> list[str]:
    out = []
    t_norm = (title or "").strip().lower()
    for raw in re.split(r"\n\s*\n|\n", text or ""):
        p = re.sub(r"\s+", " ", raw).strip().strip("|").strip()
        if not p:
            continue
        if re.match(r"^(thanks to .{0,200}(reading|drafts)|notes$|related:)", p, re.I):
            break  # essay footers (paulgraham.com etc.)
        if p.startswith("Want to start a startup?"):
            continue
        letters = sum(ch.isalpha() for ch in p)
        if letters < 0.55 * len(p):
            continue  # ascii tables, rules, link bars
        if p.lower() == t_norm:
            continue
        if BOILERPLATE.match(p):
            continue
        if p.startswith("## "):
            out.append(p)
            continue
        if len(p.split()) < 5 and not p.endswith((".", "?", "!", "\"", "”")):
            continue  # captions, bylines, stray labels
        out.append(p)
    # de-duplicate consecutive repeats (pull quotes etc.)
    dedup = []
    for p in out:
        if not dedup or dedup[-1] != p:
            dedup.append(p)
    return dedup


def trim(paras: list[str], max_words: int = MAX_WORDS) -> tuple[list[str], bool]:
    out, n = [], 0
    for p in paras:
        w = len(p.split())
        if n + w > max_words and n >= max_words * 0.6:
            # drop a trailing heading with no body
            while out and out[-1].startswith("## "):
                out.pop()
            return out, True
        out.append(p)
        n += w
    return out, False


def finalize(paras: list[str], *, key: str, title: str, kind: str, categories: list, source_id: str,
             source_name: str, url: str = None, author: str = None, published: str = None,
             max_words: int = MAX_WORDS, min_words: int = MIN_WORDS, check_flesch: bool = True):
    paras, truncated = trim(paras, max_words)
    while paras and (paras[-1].startswith("## ") or not paras[-1].rstrip().endswith((".", "?", "!", '"', "”", "’", ")"))):
        paras.pop()  # drop dangling headings / half sentences at the end
    text = "\n\n".join(paras)
    plain = " ".join(p.removeprefix("## ") for p in paras)
    words = len(plain.split())
    if words < min_words:
        return None, f"too short ({words}w)"
    flesch = round(textstat.flesch_reading_ease(plain), 1)
    if check_flesch and flesch < MIN_FLESCH:
        return None, f"too dense (flesch {flesch})"
    return {
        "id": pid(key), "title": title.strip(), "author": author, "url": url, "kind": kind,
        "categories": categories, "source_id": source_id, "source_name": source_name,
        "text": text, "words": words, "flesch": flesch, "published": published,
        "truncated": truncated,
    }, "ok"


def extract_page(url: str, ua: str = "default", html: str = None) -> dict:
    if html is None:
        r = http_get(url, ua)
        r.raise_for_status()
        html = r.text
    data = trafilatura.extract(html, url=url, output_format="json", with_metadata=True,
                               include_comments=False, include_tables=False, favor_precision=True)
    if not data:
        data = trafilatura.extract(html, url=url, output_format="json", with_metadata=True,
                                   include_comments=False, include_tables=True, favor_recall=True)
    if not data:
        return {}
    d = json.loads(data)
    if "paulgraham.com" in url or len((d.get("text") or "").split()) < 150 or (d.get("text") or "").count("|") > 2 or len((d.get("text") or "").split()) > 300 * (1 + (d.get("text") or "").count("\n")):  # table layouts (e.g. paulgraham.com): crude fallback
        body = re.sub(r"(?is)<!--.*?-->|<(script|style|head|nav)\b.*?</\1>", " ", html)
        body = re.sub(r"(?i)<br\s*/?>\s*<br\s*/?>|</p>", "\n\n", body)
        body = re.sub(r"<[^>]+>", " ", body)
        import html as _h
        txt = "\n\n".join(re.sub(r"\s+", " ", b).strip() for b in re.split(r"\n\s*\n", _h.unescape(body)))
        if "paulgraham.com" in url or len(txt.split()) > len((d.get("text") or "").split()):
            d["text"] = txt
    if not d.get("title"):
        m = re.search(r"(?is)<title>(.*?)</title>", html)
        d["title"] = m.group(1).strip() if m else None
    return d


# ---------------------------------------------------------------- source types

def ingest_page(src: dict, url: str = None, ua: str = None, title: str = None, published: str = None):
    url = url or src["url"]
    ua = ua or src.get("ua", "default")
    d = extract_page(url, ua)
    if not d.get("text"):
        return None, "no text extracted"
    title = title or src.get("title") or d.get("title") or url
    paras = clean_paragraphs(d["text"], title)
    return finalize(paras, key=url, title=title, kind=src.get("kind", "blog"),
                    categories=src.get("categories", []), source_id=src.get("id", "page"),
                    source_name=src.get("name") or d.get("sitename") or "",
                    url=url, author=d.get("author"), published=published or d.get("date"))


def ingest_feed(src: dict, con, known_urls: set):
    r = http_get(src["url"])
    feed = feedparser.parse(r.content)
    accepted, log = [], []
    for e in feed.entries[: max(src.get("max_items", 3) * 4, 8)]:
        if len(accepted) >= src.get("max_items", 3):
            break
        link = e.get("link")
        if not link or link in known_urls:
            continue
        if re.search(r"/(video|interactive|live|podcasts?|slideshow|crosswords|briefing)/", link):
            continue
        if src.get("exclude") and re.search(src["exclude"], e.get("title", ""), re.I):
            continue
        try:
            p, why = ingest_page(src, url=link, title=e.get("title"), published=e.get("published"))
        except Exception as ex:  # noqa: BLE001
            p, why = None, f"error {ex.__class__.__name__}"
        log.append(f"  {'+' if p else '-'} {e.get('title', '')[:70]}  [{why}]")
        if p:
            accepted.append(p)
    return accepted, log


_wiki_lock = threading.Lock()


def wiki_extract(title: str) -> str:
    with _wiki_lock:
        for attempt in range(5):
            r = httpx.get("https://en.wikipedia.org/w/api.php", params={
        "action": "query", "prop": "extracts", "explaintext": 1, "titles": title,
        "format": "json", "redirects": 1}, headers={"User-Agent": WIKI_UA}, timeout=25)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("application/json"):
                time.sleep(0.5)
                pages = r.json()["query"]["pages"]
                return next(iter(pages.values())).get("extract", "")
            time.sleep(2 * (attempt + 1))
        r.raise_for_status()
        raise RuntimeError(f"wikipedia returned {r.status_code}")


def ingest_wikipedia(src: dict):
    text = wiki_extract(src["title"])
    parts = re.split(r"^(={2,4})\s*(.+?)\s*\1\s*$", text, flags=re.M)
    lead = parts[0]
    sections = []  # (level, name, body)
    for i in range(1, len(parts), 3):
        sections.append((len(parts[i]), parts[i + 1], parts[i + 2]))
    paras = clean_paragraphs(lead)
    wanted = [s.lower() for s in src.get("sections", [])]
    include, top = False, None
    for level, name, body in sections:
        if level == 2:
            top = name.lower()
            if top in SKIP_WIKI_SECTIONS:
                include = False
                continue
            include = (top in wanted) if wanted else True
        if not include:
            continue
        body_paras = clean_paragraphs(body)
        if body_paras:
            paras.append(f"## {name}")
            paras.extend(body_paras)
    url = "https://en.wikipedia.org/wiki/" + src["title"].replace(" ", "_")
    return finalize(paras, key=url, title=src["title"], kind="knowledge", categories=src.get("categories", []),
                    source_id="wikipedia", source_name="Wikipedia", url=url, max_words=src.get("max_words", 1400),
                    min_words=300)


def gutenberg_text(gid: int) -> str:
    path = CACHE / "gutenberg" / f"{gid}.txt"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        r = http_get(f"https://www.gutenberg.org/cache/epub/{gid}/pg{gid}.txt", timeout=60)
        r.raise_for_status()
        path.write_text(r.text)
    t = path.read_text()
    s = t.find("*** START OF")
    e = t.find("*** END OF")
    t = t[t.find("\n", s) + 1 if s >= 0 else 0: e if e > 0 else None]
    return t.replace("\r\n", "\n")


def ingest_book_excerpt(book: dict, ex: dict):
    text = gutenberg_text(book["gutenberg_id"])
    lines = text.split("\n")
    idx = max((i for i, l in enumerate(lines) if l.strip() == ex["heading"].strip()), default=None)
    if idx is None:
        return None, f"heading not found: {ex['heading']}"
    rest = "\n".join(lines[idx + 1:])
    blocks = [re.sub(r"\s+", " ", b).strip() for b in re.split(r"\n\s*\n", rest)]
    paras = []
    for b in blocks:
        if not b:
            continue
        if re.fullmatch(r"\[?(illustration|footnote).*", b, re.I) or b.startswith("[Illustration"):
            continue
        if not paras and (b.isupper() or len(b.split()) < 6):
            continue  # leading heading fragments
        if b.isupper() and len(b.split()) < 12 and paras and not ex.get("no_break"):
            break  # next chapter heading
        b = re.sub(r"\[\d+\]|\[Footnote.*?\]", "", b)
        b = re.sub(r"_([^_]+)_", r"\1", b)
        paras.append(b)
        if sum(len(p.split()) for p in paras) > 2000:
            break
    paras = paras[ex.get("skip_paragraphs", 0):]
    heading = ex.get("title") or ex["heading"].strip(". ").title().replace("—", " — ")
    key = f"gutenberg:{book['gutenberg_id']}:{ex['heading']}"
    return finalize(paras, key=key, title=f"{book['title']}: {heading}", kind="book",
                    categories=ex.get("categories", []), source_id=f"gutenberg-{book['gutenberg_id']}",
                    source_name=f"{book['author']} · {book['title']}", author=book["author"],
                    url=f"https://www.gutenberg.org/ebooks/{book['gutenberg_id']}",
                    max_words=ex.get("max_words", 1300), check_flesch=False)


def ingest_text(title: str, text: str, categories: list, kind: str = "blog", source_name: str = "Pasted"):
    paras = clean_paragraphs(text, title)
    return finalize(paras, key=f"paste:{title}:{len(text)}:{text[:200]}", title=title, kind=kind,
                    categories=categories, source_id="pasted", source_name=source_name,
                    max_words=6000, min_words=100, check_flesch=False)


# ---------------------------------------------------------------- orchestration

def load_sources() -> dict:
    return json.loads(SOURCES.read_text())


def save_sources(s: dict):
    SOURCES.write_text(json.dumps(s, indent=2, ensure_ascii=False) + "\n")


def refresh(only: set = None, log=print) -> dict:
    con = db.connect()
    s = load_sources()
    known = {r[0] for r in con.execute("SELECT url FROM passages WHERE url IS NOT NULL")}
    stats = {"new": 0, "seen": 0, "failed": 0}

    def store(p):
        p.pop("truncated", None)
        if db.upsert_passage(con, p):
            stats["new"] += 1
        else:
            stats["seen"] += 1

    jobs = []
    if not only or "feeds" in only:
        for f in s.get("feeds", []):
            if f.get("enabled", True):
                jobs.append(("feed", f))
    if not only or "pages" in only:
        jobs += [("page", p) for p in s.get("pages", []) if p["url"] not in known]
    if not only or "wikipedia" in only:
        jobs += [("wiki", w) for w in s.get("wikipedia", [])
                 if "https://en.wikipedia.org/wiki/" + w["title"].replace(" ", "_") not in known]
    if not only or "books" in only:
        for b in s.get("books", []):
            for ex in b.get("excerpts", []):
                jobs.append(("book", (b, ex)))

    def run(job):
        typ, src = job
        try:
            if typ == "feed":
                return typ, src, ingest_feed(src, con, known)
            if typ == "page":
                return typ, src, ingest_page(src)
            if typ == "wiki":
                return typ, src, ingest_wikipedia(src)
            if typ == "book":
                return typ, src, ingest_book_excerpt(*src)
        except Exception as ex:  # noqa: BLE001
            return typ, src, (None, f"error {ex.__class__.__name__}: {ex}")

    with ThreadPoolExecutor(8) as pool:
        for typ, src, res in pool.map(run, jobs):
            if typ == "feed":
                if isinstance(res, tuple) and isinstance(res[0], list):
                    items, lines = res
                    log(f"[feed] {src['name']}: +{len(items)}")
                    for line in lines:
                        log(line)
                    for p in items:
                        store(p)
                else:
                    stats["failed"] += 1
                    log(f"[feed] {src['name']}: FAILED {res[1]}")
                continue
            p, why = res
            label = src.get("title") or src.get("url") if isinstance(src, dict) else f"{src[0]['title']} / {src[1]['heading']}"
            log(f"[{typ}] {'+' if p else '-'} {label}  [{why}]")
            if p:
                store(p)
            else:
                stats["failed"] += 1
    log(f"done: {stats}")
    return stats


if __name__ == "__main__":
    refresh(set(sys.argv[1:]) or None)
