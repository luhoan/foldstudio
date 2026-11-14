import json
import sqlite3
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS structures (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, source TEXT NOT NULL, origin_id TEXT,
  format TEXT NOT NULL, sha256 TEXT NOT NULL, chains TEXT NOT NULL, n_residues INTEGER NOT NULL,
  file_path TEXT NOT NULL, pae_path TEXT, provenance TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL
);
"""


@contextmanager
def db(ctx):
    conn = sqlite3.connect(ctx.db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(ctx):
    with db(ctx) as c:
        c.executescript(SCHEMA)


def structure_row_to_dict(row) -> dict:
    d = dict(row)
    d["chains"] = json.loads(d["chains"])
    d["provenance"] = json.loads(d["provenance"])
    d["has_pae"] = bool(d.pop("pae_path"))
    d.pop("file_path")
    return d
