#!/usr/bin/env python3
"""PDF-Manager: leichtgewichtiger Webserver zum Taggen, Umbenennen und Betrachten
von PDFs auf einem (Netz-)Laufwerk. Nur Python-Standardbibliothek.

Konfiguration in config.ini (neben server.py). Umgebungsvariablen haben Vorrang:
  PDF_ROOT, PDF_DB, PDF_HOST, PDF_PORT, PDF_PASSWORD, PDF_SCAN_TTL
"""

import base64
import configparser
import hashlib
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get("PDF_CONFIG", os.path.join(APP_DIR, "config.ini"))

_cfg = configparser.ConfigParser(interpolation=None)
_cfg.read(CONFIG_PATH, encoding="utf-8")


def setting(key, default):
    """Wert aus Umgebungsvariable PDF_<KEY>, sonst config.ini [pdf-manager], sonst default."""
    return os.environ.get("PDF_" + key.upper()) or _cfg.get("pdf-manager", key, fallback="").strip() or default


def app_path(p):
    """Relative Pfade beziehen sich auf das Programmverzeichnis; ~ wird aufgelöst."""
    return os.path.join(APP_DIR, os.path.expanduser(p))


ROOT = os.path.realpath(app_path(setting("root", "/mnt/Michi")))
DB_PATH = app_path(setting("db", "data/pdfmanager.db"))
HOST = setting("host", "0.0.0.0")
PORT = int(setting("port", "8800"))
PASSWORD = setting("password", "")
SCAN_TTL = float(setting("scan_ttl", "120"))
THUMB_DIR = os.path.join(os.path.dirname(DB_PATH), "thumbs")
THUMB_WIDTH = 360
# Vorschaubilder serverseitig mit pdftoppm (poppler-utils), sonst rendert der Browser sie
PDFTOPPM = shutil.which("pdftoppm")
thumb_slots = threading.Semaphore(2)

TRASH_DIR_NAME = ".pdf-papierkorb"
TRASH_DIR = os.path.join(ROOT, TRASH_DIR_NAME)
STATIC_DIR = os.path.join(APP_DIR, "static")
# Verzeichnisse, die beim Scannen übersprungen werden (zusätzlich zu allen ".*")
SKIP_DIRS = {"#recycle", "@eaDir", "$RECYCLE.BIN", "System Volume Information", "lost+found"}
INVALID_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


# --------------------------------------------------------------------------- DB

class Store:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock, self.db:
            self.db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS files (
                    path TEXT PRIMARY KEY,
                    size INTEGER,
                    first_seen REAL,
                    is_new INTEGER DEFAULT 1,
                    present INTEGER DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS tags (
                    path TEXT, tag TEXT, PRIMARY KEY (path, tag)
                );
                CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
                CREATE TABLE IF NOT EXISTS trash (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    orig_path TEXT, trash_path TEXT, size INTEGER,
                    deleted_at REAL, tags TEXT
                );
            """)

    def tags_by_path(self):
        out = {}
        for r in self.db.execute("SELECT path, tag FROM tags ORDER BY tag COLLATE NOCASE"):
            out.setdefault(r["path"], []).append(r["tag"])
        return out

    def move_path(self, old, new):
        """Tags und Status von old nach new übertragen (Umbenennen/Verschieben)."""
        self.db.execute("DELETE FROM files WHERE path=?", (new,))
        self.db.execute("DELETE FROM tags WHERE path=?", (new,))
        self.db.execute("UPDATE files SET path=? WHERE path=?", (new, old))
        self.db.execute("UPDATE tags SET path=? WHERE path=?", (new, old))


store = None  # wird in main() initialisiert


# ------------------------------------------------------------------------- Scan

class Scanner:
    def __init__(self):
        self.lock = threading.Lock()
        self.files = {}          # relpath -> {"size":, "mtime":}
        self.scanned_at = 0.0
        self.scan_duration = 0.0

    def _walk(self):
        found = {}
        for dirpath, dirnames, filenames in os.walk(ROOT, onerror=lambda e: None):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS]
            for fn in filenames:
                if not fn.lower().endswith(".pdf") or fn.startswith("."):
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
                found[rel] = {"size": st.st_size, "mtime": st.st_mtime}
        return found

    def scan(self, force=False):
        with self.lock:
            if not force and self.files and time.time() - self.scanned_at < SCAN_TTL:
                return
            t0 = time.time()
            found = self._walk()
            self._sync_db(found)
            self.files = found
            self.scanned_at = time.time()
            self.scan_duration = self.scanned_at - t0

    def _sync_db(self, found):
        now = time.time()
        with store.lock, store.db:
            db = store.db
            first_run = db.execute("SELECT COUNT(*) FROM files").fetchone()[0] == 0
            known = {r["path"]: r for r in db.execute("SELECT path, size, present FROM files")}
            new_paths = [p for p in found if p not in known]
            missing = [p for p, r in known.items() if p not in found]

            # Außerhalb der App verschobene/umbenannte Dateien wiedererkennen:
            # gleicher Dateiname + gleiche Größe -> Tags übernehmen.
            by_key = {}
            for p in missing:
                by_key.setdefault((os.path.basename(p), known[p]["size"]), []).append(p)
            for p in new_paths:
                cands = by_key.get((os.path.basename(p), found[p]["size"]))
                if cands:
                    old = cands.pop()
                    store.move_path(old, p)
                    db.execute("UPDATE files SET present=1 WHERE path=?", (p,))
                    missing.remove(old)
                    continue
                # Beim allerersten Scan gilt der Bestand nicht als "neu".
                db.execute(
                    "INSERT INTO files(path, size, first_seen, is_new, present) VALUES (?,?,?,?,1)",
                    (p, found[p]["size"], now, 0 if first_run else 1))

            for p in missing:
                has_tags = db.execute("SELECT 1 FROM tags WHERE path=? LIMIT 1", (p,)).fetchone()
                if has_tags:
                    # behalten (falls das Laufwerk nur kurz weg ist oder die Datei zurückkommt)
                    db.execute("UPDATE files SET present=0 WHERE path=?", (p,))
                else:
                    db.execute("DELETE FROM files WHERE path=?", (p,))
            db.executemany("UPDATE files SET size=?, present=1 WHERE path=?",
                           [(v["size"], p) for p, v in found.items()])

    def listing(self):
        self.scan()
        with store.lock:
            tags = store.tags_by_path()
            meta = {r["path"]: r for r in store.db.execute(
                "SELECT path, first_seen, is_new FROM files WHERE present=1")}
        out = []
        for p, v in self.files.items():
            m = meta.get(p)
            folder, _, name = p.rpartition("/")
            out.append({
                "path": p, "name": name, "folder": folder,
                "size": v["size"], "mtime": v["mtime"],
                "first_seen": m["first_seen"] if m else None,
                "new": bool(m["is_new"]) if m else True,
                "tags": tags.get(p, []),
            })
        return out

    def forget(self, rel):
        with self.lock:
            self.files.pop(rel, None)

    def add(self, rel):
        full = abs_path(rel)
        st = os.stat(full)
        with self.lock:
            self.files[rel] = {"size": st.st_size, "mtime": st.st_mtime}


scanner = Scanner()


# ---------------------------------------------------------------------- Helpers

class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status, self.msg = status, msg


def abs_path(rel, must_exist=True):
    """Relativen Pfad sicher in absoluten Pfad innerhalb ROOT umwandeln."""
    if not isinstance(rel, str) or not rel or "\x00" in rel:
        raise ApiError(400, "Ungültiger Pfad")
    full = os.path.realpath(os.path.join(ROOT, rel))
    if not full.startswith(ROOT + os.sep):
        raise ApiError(403, "Pfad außerhalb des Wurzelverzeichnisses")
    if full.startswith(TRASH_DIR + os.sep):
        raise ApiError(403, "Pfad im Papierkorb")
    if not full.lower().endswith(".pdf"):
        raise ApiError(403, "Nur PDF-Dateien erlaubt")
    if must_exist and not os.path.isfile(full):
        raise ApiError(404, "Datei nicht gefunden")
    return full


def rel_path(full):
    return os.path.relpath(full, ROOT).replace(os.sep, "/")


def clean_tags(tags):
    if not isinstance(tags, list):
        raise ApiError(400, "tags muss eine Liste sein")
    out = []
    for t in tags:
        t = re.sub(r"\s+", " ", str(t)).strip()[:60]
        if t and t.lower() not in (x.lower() for x in out):
            out.append(t)
    return out


def unique_target(directory, name):
    stem, ext = os.path.splitext(name)
    cand, i = os.path.join(directory, name), 1
    while os.path.exists(cand):
        cand = os.path.join(directory, f"{stem} ({i}){ext}")
        i += 1
    return cand


# ---------------------------------------------------------------------- Actions

def api_set_tags(body):
    rel = body.get("path")
    abs_path(rel)
    tags = clean_tags(body.get("tags", []))
    with store.lock, store.db:
        store.db.execute("DELETE FROM tags WHERE path=?", (rel,))
        store.db.executemany("INSERT INTO tags(path, tag) VALUES (?,?)", [(rel, t) for t in tags])
        store.db.execute("UPDATE files SET is_new=0 WHERE path=?", (rel,))
    return {"path": rel, "tags": tags}


def api_bulk_tags(body):
    paths = body.get("paths") or []
    add = clean_tags(body.get("add", []))
    remove = {t.lower() for t in clean_tags(body.get("remove", []))}
    for p in paths:
        abs_path(p)
    with store.lock, store.db:
        for p in paths:
            cur = [r["tag"] for r in store.db.execute("SELECT tag FROM tags WHERE path=?", (p,))]
            new = clean_tags([t for t in cur if t.lower() not in remove] + add)
            store.db.execute("DELETE FROM tags WHERE path=?", (p,))
            store.db.executemany("INSERT INTO tags(path, tag) VALUES (?,?)", [(p, t) for t in new])
            store.db.execute("UPDATE files SET is_new=0 WHERE path=?", (p,))
    return {"ok": True}


def api_rename_tag(body):
    old = str(body.get("old", "")).strip()
    new = clean_tags([body.get("new", "")])
    if not old or not new:
        raise ApiError(400, "Alter und neuer Tag-Name erforderlich")
    new = new[0]
    with store.lock, store.db:
        rows = store.db.execute("SELECT path FROM tags WHERE tag=?", (old,)).fetchall()
        for r in rows:
            store.db.execute("DELETE FROM tags WHERE path=? AND tag=?", (r["path"], old))
            store.db.execute("INSERT OR IGNORE INTO tags(path, tag) VALUES (?,?)", (r["path"], new))
    return {"ok": True, "count": len(rows)}


def api_seen(body):
    rel = body.get("path")
    with store.lock, store.db:
        store.db.execute("UPDATE files SET is_new=0 WHERE path=?", (rel,))
    return {"ok": True}


def api_rename(body):
    rel = body.get("path")
    full = abs_path(rel)
    name = str(body.get("name", "")).strip()
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    if INVALID_NAME_CHARS.search(name) or name.startswith(".") or len(name) > 240:
        raise ApiError(400, 'Ungültiger Dateiname (verboten: \\ / : * ? " < > | sowie führender Punkt)')
    target = os.path.join(os.path.dirname(full), name)
    if target == full:
        return {"path": rel}
    # Groß-/Kleinschreibung ändern ist auf SMB erlaubt, obwohl "exists" True liefert
    if os.path.exists(target) and os.path.normcase(target) != os.path.normcase(full) \
            and not os.path.samefile(target, full):
        raise ApiError(409, "Eine Datei mit diesem Namen existiert bereits")
    os.rename(full, target)
    new_rel = rel_path(target)
    with store.lock, store.db:
        store.move_path(rel, new_rel)
    scanner.forget(rel)
    scanner.add(new_rel)
    return {"path": new_rel}


def api_trash(body):
    paths = body.get("paths") or []
    os.makedirs(TRASH_DIR, exist_ok=True)
    moved = []
    for rel in paths:
        full = abs_path(rel)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        target = unique_target(TRASH_DIR, f"{stamp}_{os.path.basename(full)}")
        size = os.path.getsize(full)
        shutil.move(full, target)
        with store.lock, store.db:
            tags = [r["tag"] for r in store.db.execute("SELECT tag FROM tags WHERE path=?", (rel,))]
            store.db.execute(
                "INSERT INTO trash(orig_path, trash_path, size, deleted_at, tags) VALUES (?,?,?,?,?)",
                (rel, os.path.basename(target), size, time.time(), json.dumps(tags)))
            store.db.execute("DELETE FROM tags WHERE path=?", (rel,))
            store.db.execute("DELETE FROM files WHERE path=?", (rel,))
        scanner.forget(rel)
        moved.append(rel)
    return {"trashed": moved}


def api_trash_list():
    with store.lock:
        rows = store.db.execute("SELECT * FROM trash ORDER BY deleted_at DESC").fetchall()
    out = []
    for r in rows:
        if not os.path.isfile(os.path.join(TRASH_DIR, r["trash_path"])):
            continue
        folder, _, name = r["orig_path"].rpartition("/")
        out.append({"id": r["id"], "path": r["orig_path"], "trash_path": r["trash_path"], "name": name, "folder": folder,
                    "size": r["size"], "deleted_at": r["deleted_at"], "tags": json.loads(r["tags"])})
    return out


def api_restore(body):
    with store.lock:
        r = store.db.execute("SELECT * FROM trash WHERE id=?", (body.get("id"),)).fetchone()
    if not r:
        raise ApiError(404, "Eintrag nicht gefunden")
    src = os.path.join(TRASH_DIR, r["trash_path"])
    if not os.path.isfile(src):
        raise ApiError(404, "Datei nicht mehr im Papierkorb")
    dest_full = abs_path(r["orig_path"], must_exist=False)
    os.makedirs(os.path.dirname(dest_full), exist_ok=True)
    dest_full = unique_target(os.path.dirname(dest_full), os.path.basename(dest_full))
    shutil.move(src, dest_full)
    rel = rel_path(dest_full)
    with store.lock, store.db:
        store.db.execute("INSERT OR REPLACE INTO files(path, size, first_seen, is_new, present) "
                         "VALUES (?,?,?,0,1)", (rel, r["size"], time.time()))
        store.db.executemany("INSERT OR IGNORE INTO tags(path, tag) VALUES (?,?)",
                             [(rel, t) for t in json.loads(r["tags"])])
        store.db.execute("DELETE FROM trash WHERE id=?", (r["id"],))
    scanner.add(rel)
    return {"path": rel}


# ------------------------------------------------------------------ Vorschau

def thumb_cache_path(rel, full):
    st = os.stat(full)
    key = hashlib.sha1(f"{rel}|{st.st_size}|{st.st_mtime}".encode()).hexdigest()
    return os.path.join(THUMB_DIR, key + ".jpg")


def get_thumb(rel):
    """Pfad zum Vorschaubild; erzeugt es bei Bedarf. None, wenn nicht möglich."""
    full = abs_path(rel)
    cache = thumb_cache_path(rel, full)
    if os.path.isfile(cache):
        return cache
    if not PDFTOPPM:
        return None
    os.makedirs(THUMB_DIR, exist_ok=True)
    with thumb_slots:
        if os.path.isfile(cache):
            return cache
        tmp = cache[:-4] + f".tmp{threading.get_ident()}"
        try:
            subprocess.run([PDFTOPPM, "-jpeg", "-jpegopt", "quality=75", "-f", "1", "-l", "1",
                            "-scale-to", str(THUMB_WIDTH), "-singlefile", full, tmp],
                           capture_output=True, timeout=60, check=True)
            os.replace(tmp + ".jpg", cache)
        except (subprocess.SubprocessError, OSError):
            if os.path.exists(tmp + ".jpg"):
                os.remove(tmp + ".jpg")
            return None
    return cache


def api_thumb_upload(body):
    """Im Browser gerenderte Vorschau speichern (Fallback ohne pdftoppm)."""
    rel = body.get("path")
    full = abs_path(rel)
    try:
        data = base64.b64decode(str(body.get("data", "")).split(",")[-1])
    except ValueError:
        raise ApiError(400, "Ungültige Bilddaten")
    if not data.startswith(b"\xff\xd8") or len(data) > 600_000:
        raise ApiError(400, "Ungültige Bilddaten")
    os.makedirs(THUMB_DIR, exist_ok=True)
    with open(thumb_cache_path(rel, full), "wb") as f:
        f.write(data)
    return {"ok": True}


# ---------------------------------------------------------------------- Handler

class Handler(BaseHTTPRequestHandler):
    server_version = "PDFManager/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # ruhig bleiben; Fehler werden separat ausgegeben

    # --- Auth
    def _authorized(self):
        if not PASSWORD:
            return True
        h = self.headers.get("Authorization", "")
        if h.startswith("Basic "):
            try:
                _, _, pw = base64.b64decode(h[6:]).decode("utf-8").partition(":")
                if pw == PASSWORD:
                    return True
            except Exception:
                pass
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="PDF-Manager", charset="UTF-8"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    # --- Output
    def _json(self, data, status=200):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _send_file(self, full, ctype, inline_name=None, cache=None):
        size = os.path.getsize(full)
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        status = 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
                else:
                    start = max(0, size - int(m.group(2)))
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if cache:
            self.send_header("Cache-Control", cache)
        if inline_name:
            q = urllib.parse.quote(inline_name)
            self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{q}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(full, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_000_000:
            raise ApiError(413, "Anfrage zu groß")
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "Ungültiges JSON")

    # --- Routing
    def _handle(self, fn):
        try:
            if not self._authorized():
                return
            fn()
        except ApiError as e:
            self._json({"error": e.msg}, e.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError as e:
            self._json({"error": f"Dateisystemfehler: {e.strerror or e}"}, 500)
        except Exception as e:  # pragma: no cover
            print("Fehler:", repr(e))
            self._json({"error": "Interner Fehler"}, 500)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self._handle(self._get)

    def do_POST(self):
        self._handle(self._post)

    def _get(self):
        url = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(url.path)
        if path == "/api/files":
            q = urllib.parse.parse_qs(url.query)
            if q.get("rescan"):
                scanner.scan(force=True)
            files = scanner.listing()
            return self._json({"root": ROOT, "scanned_at": scanner.scanned_at,
                               "scan_duration": round(scanner.scan_duration, 2), "files": files})
        if path == "/api/trash":
            return self._json({"items": api_trash_list()})
        if path.startswith("/pdf/"):
            full = abs_path(path[5:])
            return self._send_file(full, "application/pdf", os.path.basename(full))
        if path.startswith("/thumb/"):
            thumb = get_thumb(path[7:])
            if not thumb:
                raise ApiError(404, "Keine Vorschau")
            return self._send_file(thumb, "image/jpeg", cache="max-age=604800")
        if path.startswith("/trashpdf/"):
            name = os.path.basename(path[10:])
            full = os.path.join(TRASH_DIR, name)
            if not name or not os.path.isfile(full):
                raise ApiError(404, "Nicht gefunden")
            return self._send_file(full, "application/pdf", name)
        # statische Dateien
        if path == "/":
            path = "/index.html"
        full = os.path.realpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(STATIC_DIR + os.sep) or not os.path.isfile(full):
            raise ApiError(404, "Nicht gefunden")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send_file(full, ctype)

    def _post(self):
        path = urllib.parse.urlsplit(self.path).path
        routes = {
            "/api/tags": api_set_tags,
            "/api/bulk-tags": api_bulk_tags,
            "/api/rename-tag": api_rename_tag,
            "/api/seen": api_seen,
            "/api/rename": api_rename,
            "/api/trash": api_trash,
            "/api/restore": api_restore,
            "/api/thumb": api_thumb_upload,
        }
        fn = routes.get(path)
        if not fn:
            raise ApiError(404, "Unbekannter Endpunkt")
        self._json(fn(self._body()))


def main():
    global store
    if not os.path.isdir(ROOT):
        raise SystemExit(f"PDF-Verzeichnis existiert nicht: {ROOT}\n"
                         f"Bitte 'root' in {CONFIG_PATH} anpassen.")
    store = Store(DB_PATH)
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("application/manifest+json", ".webmanifest")
    print(f"PDF-Manager: {ROOT}  ->  http://{HOST}:{PORT}  (DB: {DB_PATH})")
    print("Vorschaubilder: " + ("pdftoppm" if PDFTOPPM else "im Browser (pdftoppm nicht gefunden)"))
    threading.Thread(target=scanner.scan, daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
