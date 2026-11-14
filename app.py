"""Speedreader web app. Run:  uv run uvicorn app:app --port 8765"""
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
import ingest
import quizgen

app = FastAPI(title="Speedreader")
STATIC = db.ROOT / "static"


@app.middleware("http")
async def revalidate_static(request, call_next):
    """Make browsers re-check the page and its JS/CSS on every load (cheap 304s),
    so code updates are picked up instead of serving a stale cached app.js."""
    resp = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp

with db.connect() as _c:
    n = db.import_quiz_files(_c)
    if n:
        print(f"imported {n} precomputed quizzes")

refresh_state = {"running": False, "log": [], "stats": None, "finished_at": None}
_locks_guard = threading.Lock()
_quiz_locks: dict = {}


def quiz_lock_for(pid: str) -> threading.Lock:
    with _locks_guard:
        return _quiz_locks.setdefault(pid, threading.Lock())


def row_meta(r) -> dict:
    return {
        "id": r["id"], "title": r["title"], "author": r["author"], "url": r["url"], "kind": r["kind"],
        "categories": json.loads(r["categories"] or "[]"), "source": r["source_name"],
        "words": r["words"], "flesch": r["flesch"], "published": r["published"], "fetched_at": r["fetched_at"],
    }


@app.get("/api/passages")
def list_passages():
    con = db.connect()
    quizzed = {r[0] for r in con.execute("SELECT passage_id FROM quizzes")}
    reads = {}
    for r in con.execute("SELECT passage_id, COUNT(*), MAX(ts) FROM results GROUP BY passage_id"):
        reads[r[0]] = {"count": r[1], "last": r[2]}
    votes = {r[0]: (r[1], r[2]) for r in con.execute("SELECT passage_id, vote, ts FROM votes")}
    out = []
    for r in con.execute("SELECT * FROM passages WHERE hidden=0 ORDER BY fetched_at DESC"):
        m = row_meta(r)
        m["has_quiz"] = r["id"] in quizzed
        m["reads"] = reads.get(r["id"], {}).get("count", 0)
        m["vote"], m["vote_ts"] = votes.get(r["id"], (0, None))
        out.append(m)
    return {"passages": out, "quiz_provider": quizgen.provider(), "affinity": db.affinity(con)}


@app.get("/api/passages/{pid}")
def get_passage(pid: str):
    con = db.connect()
    r = con.execute("SELECT * FROM passages WHERE id=?", (pid,)).fetchone()
    if not r:
        raise HTTPException(404, "not found")
    m = row_meta(r)
    m["text"] = r["text"]
    m["has_quiz"] = db.get_quiz(con, pid) is not None
    v = con.execute("SELECT vote FROM votes WHERE passage_id=?", (pid,)).fetchone()
    m["vote"] = v[0] if v else 0
    return m


class Vote(BaseModel):
    vote: int  # 1 = upvote, -1 = downvote, 0 = clear


@app.post("/api/passages/{pid}/vote")
def vote(pid: str, v: Vote):
    con = db.connect()
    if not con.execute("SELECT 1 FROM passages WHERE id=?", (pid,)).fetchone():
        raise HTTPException(404, "not found")
    db.set_vote(con, pid, v.vote)
    return {"ok": True, "vote": max(-1, min(1, v.vote))}


def ensure_quiz(pid: str):
    con = db.connect()
    q = db.get_quiz(con, pid)
    if q:
        return q
    if not quizgen.provider():
        return None
    r = con.execute("SELECT title, text FROM passages WHERE id=?", (pid,)).fetchone()
    if not r:
        return None
    with quiz_lock_for(pid):  # avoid double-generation of the same quiz; different passages run in parallel
        q = db.get_quiz(con, pid)
        if q:
            return q
        questions, model = quizgen.generate(r["title"], r["text"])
        db.save_quiz(con, pid, questions, model)
        return {"questions": questions, "model": model}


@app.get("/api/passages/{pid}/quiz")
def get_quiz(pid: str):
    try:
        q = ensure_quiz(pid)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"quiz generation failed: {e}")
    if not q:
        raise HTTPException(409, "No quiz for this passage yet and no LLM key configured (add one to .env).")
    return q


@app.post("/api/passages/{pid}/hide")
def hide(pid: str):
    con = db.connect()
    con.execute("UPDATE passages SET hidden=1 WHERE id=?", (pid,))
    con.commit()
    return {"ok": True}


class Result(BaseModel):
    passage_id: str
    mode: str
    words: int
    seconds: float
    target_wpm: float | None = None
    score: int | None = None
    total: int | None = None
    answers: list | None = None


@app.post("/api/results")
def save_result(r: Result):
    con = db.connect()
    wpm = r.words / max(r.seconds, 1) * 60
    eff = wpm * (r.score / r.total) if r.total else None
    con.execute(
        "INSERT INTO results (passage_id, ts, mode, words, seconds, wpm, target_wpm, score, total, effective_wpm, answers)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (r.passage_id, time.time(), r.mode, r.words, r.seconds, wpm, r.target_wpm, r.score, r.total, eff,
         json.dumps(r.answers or [])),
    )
    con.commit()
    rid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
    return {"id": rid, "wpm": wpm, "effective_wpm": eff}


@app.get("/api/results")
def results():
    con = db.connect()
    rows = con.execute(
        "SELECT r.*, p.title, p.categories, p.kind, p.flesch FROM results r LEFT JOIN passages p ON p.id=r.passage_id"
        " ORDER BY r.ts").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["categories"] = json.loads(d["categories"] or "[]")
        d.pop("answers", None)
        out.append(d)
    return {"results": out}


@app.delete("/api/results/{rid}")
def delete_result(rid: int):
    con = db.connect()
    con.execute("DELETE FROM results WHERE id=?", (rid,))
    con.commit()
    return {"ok": True}


# ---------------------------------------------------------------- adding content

class AddUrl(BaseModel):
    url: str
    categories: list[str] = []
    kind: str = "blog"
    googlebot: bool = False


class AddText(BaseModel):
    title: str
    text: str
    categories: list[str] = []
    kind: str = "blog"
    source: str = "Pasted"


class AddFeed(BaseModel):
    name: str
    url: str
    categories: list[str] = []
    kind: str = "blog"
    max_items: int = 3
    googlebot: bool = False


def _bg_quiz(pid: str):
    if quizgen.provider():
        threading.Thread(target=lambda: _safe(ensure_quiz, pid), daemon=True).start()


def _safe(fn, *a):
    try:
        fn(*a)
    except Exception as e:  # noqa: BLE001
        print("background error:", e)


@app.post("/api/add/url")
def add_url(a: AddUrl):
    src = {"url": a.url, "kind": a.kind, "categories": a.categories, "ua": "googlebot" if a.googlebot else "default"}
    try:
        p, why = ingest.ingest_page(src)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"could not fetch: {e}")
    if not p:
        raise HTTPException(400, f"could not use this page: {why}")
    p.pop("truncated", None)
    con = db.connect()
    db.upsert_passage(con, p)
    s = ingest.load_sources()
    if not any(x["url"] == a.url for x in s["pages"]):
        s["pages"].append({"url": a.url, "name": p["source_name"], "kind": a.kind, "categories": a.categories})
        ingest.save_sources(s)
    _bg_quiz(p["id"])
    return {"id": p["id"], "title": p["title"], "words": p["words"]}


@app.post("/api/add/text")
def add_text(a: AddText):
    p, why = ingest.ingest_text(a.title, a.text, a.categories, a.kind, a.source)
    if not p:
        raise HTTPException(400, why)
    p.pop("truncated", None)
    db.upsert_passage(db.connect(), p)
    _bg_quiz(p["id"])
    return {"id": p["id"], "title": p["title"], "words": p["words"]}


@app.post("/api/add/feed")
def add_feed(a: AddFeed):
    s = ingest.load_sources()
    fid = ingest.pid(a.url)
    if any(f["url"] == a.url for f in s["feeds"]):
        raise HTTPException(400, "feed already added")
    feed = {"id": fid, "name": a.name, "url": a.url, "kind": a.kind, "categories": a.categories,
            "max_items": a.max_items}
    if a.googlebot:
        feed["ua"] = "googlebot"
    s["feeds"].append(feed)
    ingest.save_sources(s)
    return {"ok": True, "id": fid}


@app.get("/api/sources")
def sources():
    s = ingest.load_sources()
    con = db.connect()
    counts = dict(con.execute("SELECT source_id, COUNT(*) FROM passages WHERE hidden=0 GROUP BY source_id").fetchall())
    aff = db.affinity(con)
    boosts = dict(con.execute("SELECT source, boost FROM source_boost").fetchall())
    for f in s["feeds"]:
        f["count"] = counts.get(f["id"], 0)
        f["score"] = aff["sources"].get(f["name"], 0)
        f["quota"] = ingest.feed_quota(f, f["score"])
    feed_names = {f["name"] for f in s["feeds"]}
    others = []
    for name, n in con.execute("SELECT source_name, COUNT(*) FROM passages WHERE hidden=0 GROUP BY source_name"):
        if name not in feed_names:
            others.append({"name": name, "count": n, "score": aff["sources"].get(name, 0)})
    others.sort(key=lambda o: (-o["score"], -o["count"]))
    return {"feeds": s["feeds"], "others": others, "boosts": boosts, "categories": aff["categories"],
            "pages": len(s["pages"]), "wikipedia": len(s["wikipedia"]),
            "wikipedia_enabled": s.get("wikipedia_enabled", True),
            "books": sum(len(b["excerpts"]) for b in s["books"]), "quiz_provider": quizgen.provider()}


class Boost(BaseModel):
    source: str
    delta: int


@app.post("/api/sources/boost")
def boost_source(b: Boost):
    """Upvote/downvote a whole source (on top of votes on its individual pieces)."""
    con = db.connect()
    cur = con.execute("SELECT boost FROM source_boost WHERE source=?", (b.source,)).fetchone()
    val = max(-5, min(5, (cur[0] if cur else 0) + (1 if b.delta > 0 else -1)))
    con.execute("INSERT OR REPLACE INTO source_boost VALUES (?,?)", (b.source, val))
    con.commit()
    return {"boost": val, "score": db.affinity(con)["sources"].get(b.source, 0)}


class FeedToggle(BaseModel):
    enabled: bool


@app.post("/api/sources/feeds/{fid}")
def toggle_feed(fid: str, t: FeedToggle):
    s = ingest.load_sources()
    for f in s["feeds"]:
        if f["id"] == fid:
            f["enabled"] = t.enabled
    ingest.save_sources(s)
    return {"ok": True}


def _run_refresh():
    refresh_state.update(running=True, log=[], stats=None)
    try:
        before = {r[0] for r in db.connect().execute("SELECT id FROM passages")}
        scores = db.affinity(db.connect())["sources"]
        stats = ingest.refresh(log=lambda m: refresh_state["log"].append(m), scores=scores)
        refresh_state["stats"] = stats
        if quizgen.provider():
            new = [r[0] for r in db.connect().execute("SELECT id FROM passages") if r[0] not in before]
            refresh_state["log"].append(f"writing quizzes for {len(new)} new passages…")

            def one(pid):
                _safe(ensure_quiz, pid)
                refresh_state["log"].append(f"quiz ready: {pid}")

            with ThreadPoolExecutor(6) as pool:
                list(pool.map(one, new))
    finally:
        refresh_state.update(running=False, finished_at=time.time())


@app.post("/api/refresh")
def start_refresh():
    if not refresh_state["running"]:
        threading.Thread(target=_run_refresh, daemon=True).start()
    return {"running": True}


@app.get("/api/refresh")
def refresh_status():
    return {**refresh_state, "log": refresh_state["log"][-40:]}


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    # Version asset URLs by file mtime so a code change always busts the browser cache.
    html = (STATIC / "index.html").read_text()
    for name in ("app.js", "app.css"):
        v = int((STATIC / name).stat().st_mtime)
        html = html.replace(f"/static/{name}", f"/static/{name}?v={v}")
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})
