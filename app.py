"""Speedreader web app. Run:  uv run uvicorn app:app --port 8765"""
import json
import threading
import time

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
import ingest
import quizgen

app = FastAPI(title="Speedreader")
STATIC = db.ROOT / "static"

with db.connect() as _c:
    n = db.import_quiz_files(_c)
    if n:
        print(f"imported {n} precomputed quizzes")

refresh_state = {"running": False, "log": [], "stats": None, "finished_at": None}
quiz_lock = threading.Lock()


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
    out = []
    for r in con.execute("SELECT * FROM passages WHERE hidden=0 ORDER BY fetched_at DESC"):
        m = row_meta(r)
        m["has_quiz"] = r["id"] in quizzed
        m["reads"] = reads.get(r["id"], {}).get("count", 0)
        out.append(m)
    return {"passages": out, "quiz_provider": quizgen.provider()}


@app.get("/api/passages/{pid}")
def get_passage(pid: str):
    con = db.connect()
    r = con.execute("SELECT * FROM passages WHERE id=?", (pid,)).fetchone()
    if not r:
        raise HTTPException(404, "not found")
    m = row_meta(r)
    m["text"] = r["text"]
    m["has_quiz"] = db.get_quiz(con, pid) is not None
    return m


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
    with quiz_lock:  # avoid double-generation from concurrent requests
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
    for f in s["feeds"]:
        f["count"] = counts.get(f["id"], 0)
    return {"feeds": s["feeds"], "pages": len(s["pages"]), "wikipedia": len(s["wikipedia"]),
            "books": sum(len(b["excerpts"]) for b in s["books"]), "quiz_provider": quizgen.provider()}


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
        stats = ingest.refresh(log=lambda m: refresh_state["log"].append(m))
        refresh_state["stats"] = stats
        if quizgen.provider():
            new = [r[0] for r in db.connect().execute("SELECT id FROM passages") if r[0] not in before]
            for pid in new:
                refresh_state["log"].append(f"quiz: {pid}")
                _safe(ensure_quiz, pid)
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
    return FileResponse(STATIC / "index.html")
