// Run: node names.test.js
const assert = require('node:assert');
const Names = require('./names.js');

const people = [
  { name: 'Ana Reyes', games: 3 },
  { name: 'Ana Cruz', games: 9 },
  { name: 'Anabel Santos', games: 20 },
  { name: 'Ben Torres', games: 5 },
  { name: 'Jose Lim', games: 2 },
  { name: 'Mika Ana', games: 1 },
  { name: 'Jo', games: 0 },
];
const names = list => list.map(p => p.name);

// First names, last names and "first + initial" all match, ignoring case.
assert.deepEqual(names(Names.suggest('torres', people)), ['Ben Torres']);
assert.deepEqual(names(Names.suggest('ANA R', people)), ['Ana Reyes']);
assert.deepEqual(Names.suggest('  ', people), []);

// Ranking: exact first name, then first-name prefix, then a later word; more games break ties.
assert.deepEqual(names(Names.suggest('ana', people)), ['Ana Cruz', 'Ana Reyes', 'Anabel Santos', 'Mika Ana']);
assert.deepEqual(names(Names.suggest('jo', people)), ['Jo', 'Jose Lim']);

// Tonight's list comes first within the same rank.
const tonight = people.map(p => (p.name === 'Ana Reyes' ? { ...p, priority: true } : p));
assert.equal(Names.suggest('ana', tonight)[0].name, 'Ana Reyes');
assert.equal(Names.suggest('ana', people, 2).length, 2);

// Resolve: unique first name, exact match beats first-name match, ambiguous, new.
assert.deepEqual(Names.resolve('ben', people), { name: 'Ben Torres' });
assert.deepEqual(Names.resolve('jo', people), { name: 'Jo' });
assert.deepEqual(Names.resolve('ana cruz', people), { name: 'Ana Cruz' });
assert.deepEqual(Names.resolve('Ana', people), { choices: ['Ana Reyes', 'Ana Cruz'] });
assert.deepEqual(Names.resolve('  Zed   Park ', people), { fresh: 'Zed Park' });
assert.deepEqual(Names.resolve('Jos', people), { fresh: 'Jos' }); // a prefix alone never resolves

console.log('names.test.js: all checks passed');
