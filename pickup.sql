PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE players (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  added_on TEXT NOT NULL
);
INSERT INTO "players" ("name","added_on") VALUES('Johnray de Fiesta','2026-11-04');
INSERT INTO "players" ("name","added_on") VALUES('Bill Alcantara','2026-11-04');
INSERT INTO "players" ("name","added_on") VALUES('Kurt Reyes','2026-11-04');
INSERT INTO "players" ("name","added_on") VALUES('Aleks Manzano','2026-11-04');
INSERT INTO "players" ("name","added_on") VALUES('Tor Calim','2026-11-04');
INSERT INTO "players" ("name","added_on") VALUES('Peter Casano','2026-11-04');
INSERT INTO "players" ("name","added_on") VALUES('Finbarr Vita','2026-11-04');
INSERT INTO "players" ("name","added_on") VALUES('Matthew Dulay','2026-11-04');
INSERT INTO "players" ("name","added_on") VALUES('Loyd Abriena','2026-11-04');
INSERT INTO "players" ("name","added_on") VALUES('Josh Quinao','2026-11-04');
INSERT INTO "players" ("name","added_on") VALUES('Arnie Sayson','2026-11-04');
INSERT INTO "players" ("name","added_on") VALUES('Nochi San Jose','2026-11-04');
INSERT INTO "players" ("name","added_on") VALUES('Emil Enriquez','2026-11-04');
INSERT INTO "players" ("name","added_on") VALUES('Jayden Ong','2026-11-04');
CREATE TABLE results (
  session INTEGER NOT NULL,
  played_on TEXT NOT NULL,
  game INTEGER NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE REFERENCES players(name),
  points INTEGER NOT NULL CHECK (points BETWEEN 0 AND 200),
  UNIQUE (session, game, name)
);
