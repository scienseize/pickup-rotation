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
INSERT INTO "players" ("name","added_on") VALUES('Dheo Rondina','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Heinz Calaguio','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Jeremiah Ramos','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Isaiah Omana','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Franco Agcaoili','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Inigo Co','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Leviathan Co','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Allain Calimlim','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Justin Jose','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Rashlee Sulla','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Jacob Agoncillo','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Alsie Grael','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Jonathan Saclayan','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Terence Espiritu','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Luis Elnas','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('James Baes','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Pat Casanp','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Pat Casano','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Kian Kaluya','2026-11-05');
INSERT INTO "players" ("name","added_on") VALUES('Jose Gabriel','2026-11-05');
CREATE TABLE results (
  session INTEGER NOT NULL,
  played_on TEXT NOT NULL,
  game INTEGER NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE REFERENCES players(name),
  points INTEGER NOT NULL CHECK (points BETWEEN 0 AND 200), fgm INTEGER NOT NULL DEFAULT 0, fga INTEGER NOT NULL DEFAULT 0, won INTEGER CHECK (won IN (0, 1)),
  UNIQUE (session, game, name)
);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',1,'Isaiah Omana',4,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',1,'Franco Agcaoili',6,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',1,'Justin Jose',4,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',1,'Kurt Reyes',15,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',1,'Matthew Dulay',6,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',1,'Loyd Abriena',10,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',1,'Josh Quinao',5,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',1,'Nochi San Jose',12,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',1,'Emil Enriquez',10,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',1,'Aleks Manzano',3,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',2,'Jacob Agoncillo',8,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',2,'Bill Alcantara',9,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',2,'Leviathan Co',2,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',2,'Dheo Rondina',6,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',2,'Jeremiah Ramos',12,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',2,'Heinz Calaguio',6,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',2,'Alsie Grael',8,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',2,'Terence Espiritu',0,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',2,'Luis Elnas',8,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',2,'Rashlee Sulla',12,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',3,'Peter Casano',14,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',3,'Isaiah Omana',10,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',3,'Franco Agcaoili',4,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',3,'Justin Jose',7,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',3,'Emil Enriquez',9,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',3,'Matthew Dulay',8,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',3,'Loyd Abriena',11,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',3,'Pat Casano',2,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',3,'Josh Quinao',6,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',3,'Bill Alcantara',17,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',4,'Kurt Reyes',5,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',4,'Leviathan Co',6,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',4,'Dheo Rondina',9,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',4,'Jeremiah Ramos',14,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',4,'Heinz Calaguio',8,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',4,'Alsie Grael',4,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',4,'Luis Elnas',11,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',4,'Rashlee Sulla',2,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',4,'Jacob Agoncillo',4,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',4,'Johnray de Fiesta',7,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',5,'Aleks Manzano',0,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',5,'Peter Casano',14,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',5,'Pat Casano',4,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',5,'Isaiah Omana',6,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',5,'Franco Agcaoili',4,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',5,'Justin Jose',20,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',5,'Matthew Dulay',2,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',5,'Loyd Abriena',6,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',5,'Bill Alcantara',7,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',5,'Josh Quinao',0,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',6,'Kurt Reyes',11,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',6,'Leviathan Co',11,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',6,'Heinz Calaguio',12,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',6,'Alsie Grael',12,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',6,'Luis Elnas',2,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',6,'Rashlee Sulla',10,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',6,'Jacob Agoncillo',14,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',6,'Peter Casano',13,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',6,'Jose Gabriel',2,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',6,'Jeremiah Ramos',8,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',6,'Tor Calim',5,0,0,NULL);
INSERT INTO "results" ("session","played_on","game","name","points","fgm","fga","won") VALUES(1793840281975,'2026-11-05',6,'Kian Kaluya',2,0,0,NULL);
