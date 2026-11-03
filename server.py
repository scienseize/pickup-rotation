"""Pick-up rotation: local server and player database.

Run:  python3 server.py [port]   (default 8000), then open http://localhost:8000
Keeps players.db (SQLite) next to this file. Standard library only.
"""
import json
import sqlite3
import sys
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATIC = {'/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/queue.js': 'queue.js',
          '/names.js': 'names.js'}
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8'}
MAX_NAME = 60
MAX_POINTS = 200
MAX_BODY = 1_000_000

# One row per player per game. Averages are queried, never stored, and the
# same rows will feed over/under lines later.
SCHEMA = """
CREATE TABLE IF NOT EXISTS players (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  added_on TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  session INTEGER NOT NULL,
  played_on TEXT NOT NULL,
  game INTEGER NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE REFERENCES players(name),
  points INTEGER NOT NULL CHECK (points BETWEEN 0 AND 200),
  UNIQUE (session, game, name)
);
"""


def connect(path=HERE / 'players.db'):
    db = sqlite3.connect(str(path))
    db.executescript(SCHEMA)
    return db


def clean_name(name):
    if not isinstance(name, str):
        raise ValueError('name must be text')
    name = ' '.join(name.split())
    if not 0 < len(name) <= MAX_NAME:
        raise ValueError('name must be 1 to %d characters' % MAX_NAME)
    return name


def whole(value, low, high, what):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError('%s must be a whole number from %d to %d' % (what, low, high))
    return value


def add_players(db, names, today=None):
    if not isinstance(names, list):
        raise ValueError('names must be a list')
    rows = [(clean_name(n), today or date.today().isoformat()) for n in names]
    with db:
        db.executemany('INSERT OR IGNORE INTO players VALUES (?, ?)', rows)


def save_game(db, session, played_on, game, rows):
    """Save one finished game. Validates everything before writing; a repeat is ignored."""
    session = whole(session, 0, 2 ** 53, 'session')
    game = whole(game, 1, 1000, 'game')
    played_on = date.fromisoformat(played_on).isoformat()
    if not isinstance(rows, list):
        raise ValueError('rows must be a list')
    if not all(isinstance(r, dict) for r in rows):
        raise ValueError('each row must be an object')
    results = [(session, played_on, game, clean_name(r['name']), whole(r['points'], 0, MAX_POINTS, 'points'))
               for r in rows]
    with db:
        db.executemany('INSERT OR IGNORE INTO players VALUES (?, ?)', [(r[3], played_on) for r in results])
        db.executemany('INSERT OR IGNORE INTO results VALUES (?, ?, ?, ?, ?)', results)


def profiles(db):
    rows = db.execute("""
        SELECT p.name, COUNT(r.points), COALESCE(SUM(r.points), 0), AVG(r.points)
        FROM players p LEFT JOIN results r ON r.name = p.name
        GROUP BY p.name ORDER BY p.name""")
    return [{'name': n, 'games': g, 'points': pts, 'avg': None if avg is None else round(avg, 1)}
            for n, g, pts, avg in rows]


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, kind='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/profiles':
            return self.send(200, profiles(self.server.db))
        name = STATIC.get(path)  # only the app's own files; never the database or this script
        if not name:
            return self.send(404, {'error': 'not found'})
        self.send(200, (HERE / name).read_bytes(), TYPES[Path(name).suffix])

    def do_POST(self):
        db = self.server.db
        # JSON only: a cross-site form can't send it without a CORS preflight, which we don't answer
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
            return self.send(415, {'error': 'send JSON'})
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length > MAX_BODY:
                raise ValueError('request too large')
            data = json.loads(self.rfile.read(length) or b'{}')
            if self.path == '/api/players':
                add_players(db, data['names'])
            elif self.path == '/api/results':
                save_game(db, data['session'], data['date'], data['game'], data['rows'])
            else:
                return self.send(404, {'error': 'not found'})
        except (ValueError, KeyError, TypeError) as e:
            return self.send(400, {'error': str(e)})
        self.send(200, profiles(db))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = HTTPServer(('127.0.0.1', port), Handler)
    server.db = connect()
    print('Pick-up rotation running at http://localhost:%d  (Ctrl+C to stop)' % port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
