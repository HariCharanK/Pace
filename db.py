"""SQLite storage for passages, quizzes and reading results."""
import json
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).parent
DATA = ROOT / "data"
DB_PATH = DATA / "speedreader.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS passages (
  id TEXT PRIMARY KEY,
  source_id TEXT, source_name TEXT,
  title TEXT, author TEXT, url TEXT,
  kind TEXT, categories TEXT,
  text TEXT, words INTEGER, flesch REAL,
  published TEXT, fetched_at REAL,
  hidden INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quizzes (
  passage_id TEXT PRIMARY KEY,
  questions TEXT, model TEXT, created_at REAL
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  passage_id TEXT, ts REAL, mode TEXT,
  words INTEGER, seconds REAL, wpm REAL, target_wpm REAL,
  score INTEGER, total INTEGER, effective_wpm REAL,
  answers TEXT
);
"""


def connect() -> sqlite3.Connection:
    DATA.mkdir(exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def upsert_passage(con, p: dict) -> bool:
    """Insert a passage; returns True if it was new."""
    exists = con.execute("SELECT 1 FROM passages WHERE id=?", (p["id"],)).fetchone()
    con.execute(
        """INSERT OR REPLACE INTO passages
        (id, source_id, source_name, title, author, url, kind, categories, text, words, flesch, published, fetched_at, hidden)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, COALESCE((SELECT hidden FROM passages WHERE id=?),0))""",
        (p["id"], p.get("source_id"), p.get("source_name"), p["title"], p.get("author"), p.get("url"),
         p["kind"], json.dumps(p.get("categories", [])), p["text"], p["words"], p.get("flesch"),
         p.get("published"), time.time(), p["id"]),
    )
    con.commit()
    return not exists


def save_quiz(con, passage_id: str, questions: list, model: str):
    con.execute("INSERT OR REPLACE INTO quizzes VALUES (?,?,?,?)",
                (passage_id, json.dumps(questions), model, time.time()))
    con.commit()


def get_quiz(con, passage_id: str):
    row = con.execute("SELECT * FROM quizzes WHERE passage_id=?", (passage_id,)).fetchone()
    if not row:
        return None
    return {"questions": json.loads(row["questions"]), "model": row["model"]}


def import_quiz_files(con) -> int:
    """Drop-in quizzes: data/quizzes/<passage_id>.json -> quizzes table."""
    qdir = DATA / "quizzes"
    n = 0
    if not qdir.exists():
        return 0
    have = {r[0]: r[1] for r in con.execute("SELECT passage_id, created_at FROM quizzes")}
    for f in qdir.glob("*.json"):
        pid = f.stem
        if pid in have and have[pid] >= f.stat().st_mtime:
            continue  # already imported and the file hasn't been edited since
        try:
            d = json.loads(f.read_text())
            qs = d["questions"] if isinstance(d, dict) else d
            if qs and all({"q", "options", "answer"} <= set(q) for q in qs):
                save_quiz(con, pid, qs, d.get("model", "precomputed") if isinstance(d, dict) else "precomputed")
                n += 1
        except Exception as e:  # noqa: BLE001
            print("bad quiz file", f, e)
    return n
