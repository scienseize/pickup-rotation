# Run: python3 test_server.py
import server

db = server.connect(':memory:')

# Weekly list: new names are added once, ignoring case and extra spaces.
server.add_players(db, ['Ana', '  ben ', 'ANA'])
assert [p['name'] for p in server.profiles(db)] == ['Ana', 'ben']

# A finished game adds rows and any unknown player; averages come from the rows.
server.save_game(db, 1, '2026-11-04', 1, [{'name': 'Ana', 'points': 10}, {'name': 'Cai', 'points': 0}])
server.save_game(db, 1, '2026-11-04', 2, [{'name': 'ana', 'points': 4}])
server.save_game(db, 1, '2026-11-04', 2, [{'name': 'Ana', 'points': 4}])  # retried save: ignored
by = {p['name']: p for p in server.profiles(db)}
assert by['Ana'] == {'name': 'Ana', 'games': 2, 'points': 14, 'avg': 7.0}, by['Ana']
assert by['Cai']['games'] == 1 and by['Cai']['avg'] == 0.0
assert by['ben']['games'] == 0 and by['ben']['avg'] is None

# Bad input is rejected, and a game with one bad row writes nothing.
for bad in (-1, 201, 2.5, '3', True):
    try:
        server.save_game(db, 2, '2026-11-11', 1, [{'name': 'Ana', 'points': 5}, {'name': 'ben', 'points': bad}])
        raise AssertionError('accepted points %r' % (bad,))
    except ValueError:
        pass
for bad in ('', '   ', 'x' * 61, 7):
    try:
        server.add_players(db, [bad])
        raise AssertionError('accepted name %r' % (bad,))
    except ValueError:
        pass
assert {p['name']: p for p in server.profiles(db)}['Ana']['games'] == 2

print('test_server.py: all checks passed')
