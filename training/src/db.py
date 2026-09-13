"""SQLite store for deployment: an audit trail of every analysis + ground-truth
feedback. No accounts, no video bytes -- only the verdict metadata and a hash of
the upload, so a scan can be identified without retaining the file.

Every call is best-effort: a storage failure must never break an analysis.
"""

from __future__ import annotations

import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

_state: dict = {"path": None}
_lock = threading.Lock()

LABELS = ("real", "ai_generated", "unsure")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS analyses (
    id             TEXT PRIMARY KEY,
    created_at     TEXT NOT NULL,
    file_name      TEXT,
    file_hash      TEXT,
    verdict        TEXT NOT NULL,
    fake_score     REAL NOT NULL,
    confidence     REAL,
    spatial_score  REAL,
    temporal_score REAL,
    frequency_score REAL,
    motion_score   REAL,
    frames_analyzed INTEGER,
    model_version  TEXT,
    real_below     REAL,
    fake_above     REAL,
    processing_ms  INTEGER
);
CREATE TABLE IF NOT EXISTS feedback (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_id  TEXT NOT NULL,
    actual_label TEXT NOT NULL,
    note         TEXT,
    created_at   TEXT NOT NULL,
    FOREIGN KEY (analysis_id) REFERENCES analyses(id)
);
CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_analysis ON feedback(analysis_id);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def _conn() -> Iterator[Optional[sqlite3.Connection]]:
    """Per-call connection, serialized. Yields None when the DB is disabled."""
    path = _state.get("path")
    if path is None:
        yield None
        return
    con = sqlite3.connect(path, timeout=5.0)
    con.row_factory = sqlite3.Row
    try:
        with _lock:
            yield con
            con.commit()
    finally:
        con.close()


def init(path: str | Path) -> None:
    """Create the file + schema. Disables itself (never raises) on failure."""
    try:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(p, timeout=5.0)
        con.executescript(_SCHEMA)
        con.execute("PRAGMA journal_mode=WAL")     # concurrent reads while writing
        con.commit()
        con.close()
        _state["path"] = str(p)
    except Exception as e:  # noqa: BLE001
        _state["path"] = None
        print(f"[db] disabled ({type(e).__name__}: {e})")


def enabled() -> bool:
    return _state.get("path") is not None


def log_analysis(result: dict, file_hash: str, processing_ms: int) -> Optional[str]:
    """Insert one analysis row; returns its id (None if the DB is off/failed)."""
    if not enabled():
        return None
    bs = result.get("branchScores") or {}
    bands = result.get("bands") or {}
    row_id = uuid.uuid4().hex
    try:
        with _conn() as con:
            if con is None:
                return None
            con.execute(
                "INSERT INTO analyses (id, created_at, file_name, file_hash, verdict,"
                " fake_score, confidence, spatial_score, temporal_score, frequency_score,"
                " motion_score, frames_analyzed, model_version, real_below, fake_above,"
                " processing_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (row_id, _now(), result.get("fileName"), file_hash, result.get("verdict"),
                 result.get("fakeScore"), result.get("confidence"), bs.get("spatial"),
                 bs.get("opticalFlow"), bs.get("frequency"), bs.get("motion"),
                 len(result.get("frames") or []), result.get("modelVersion"),
                 bands.get("realBelow"), bands.get("fakeAbove"), processing_ms),
            )
        return row_id
    except Exception as e:  # noqa: BLE001
        print(f"[db] log_analysis failed: {type(e).__name__}: {e}")
        return None


def save_feedback(analysis_id: str, actual_label: str, note: str | None) -> bool:
    """Record what the clip actually was. False if unknown id or bad label."""
    if not enabled() or actual_label not in LABELS:
        return False
    try:
        with _conn() as con:
            if con is None:
                return False
            exists = con.execute("SELECT 1 FROM analyses WHERE id = ?", (analysis_id,)).fetchone()
            if not exists:
                return False
            con.execute(
                "INSERT INTO feedback (analysis_id, actual_label, note, created_at)"
                " VALUES (?,?,?,?)",
                (analysis_id, actual_label, (note or "").strip()[:500] or None, _now()),
            )
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[db] save_feedback failed: {type(e).__name__}: {e}")
        return False


def stats() -> dict:
    """Aggregates + real-world accuracy measured against collected feedback."""
    if not enabled():
        return {"enabled": False}
    try:
        with _conn() as con:
            if con is None:
                return {"enabled": False}
            total = con.execute("SELECT COUNT(*) c FROM analyses").fetchone()["c"]
            verdicts = {r["verdict"]: r["c"] for r in con.execute(
                "SELECT verdict, COUNT(*) c FROM analyses GROUP BY verdict")}
            # newest feedback per analysis wins; 'unsure' excluded from accuracy
            rows = con.execute(
                "SELECT a.verdict, f.actual_label FROM analyses a JOIN feedback f"
                " ON f.id = (SELECT id FROM feedback WHERE analysis_id = a.id"
                "            ORDER BY id DESC LIMIT 1)"
                " WHERE f.actual_label != 'unsure'").fetchall()
            n_fb = con.execute("SELECT COUNT(DISTINCT analysis_id) c FROM feedback").fetchone()["c"]

        tp = sum(1 for r in rows if r["verdict"] == "fake" and r["actual_label"] == "ai_generated")
        tn = sum(1 for r in rows if r["verdict"] == "real" and r["actual_label"] == "real")
        fp = sum(1 for r in rows if r["verdict"] == "fake" and r["actual_label"] == "real")
        fn = sum(1 for r in rows if r["verdict"] == "real" and r["actual_label"] == "ai_generated")
        decided = tp + tn + fp + fn
        return {
            "enabled": True,
            "analyses": total,
            "verdicts": verdicts,
            "feedback": n_fb,
            "labeled_decided": decided,     # excludes 'uncertain' verdicts + 'unsure' labels
            "real_world_accuracy": round((tp + tn) / decided, 4) if decided else None,
            "confusion": {"tp": tp, "tn": tn, "fp": fp, "fn": fn},
        }
    except Exception as e:  # noqa: BLE001
        return {"enabled": True, "error": f"{type(e).__name__}: {e}"}
