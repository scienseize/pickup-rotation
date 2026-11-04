// Name matching for check-in and tonight's list. No DOM. A plain script (not a
// module) so index.html works from file://; the export guard is for Node.
// People are { name, games, priority? }; priority marks tonight's list.

const Names = {
  norm: s => String(s).trim().replace(/\s+/g, ' ').toLowerCase(),
  clean: s => Names.proper(String(s).trim().replace(/\s+/g, ' ').slice(0, 60)),

  // Proper case for words typed in the wrong case: "juan", "JUAN" and "jUAN" become "Juan",
  // "o'neil" becomes "O'Neil", each part of "anne-marie" is fixed. A word that starts with a
  // capital and has lowercase letters is kept as typed, so "McDonald" and "DeShawn" survive.
  proper: s => s.replace(/[^\s-]+/g, w => (/^\p{Lu}.*\p{Ll}/u.test(w) ? w
    : w.toLowerCase().replace(/(^|')(\p{L})/gu, (_, a, b) => a + b.toUpperCase()))),

  // 0 exact name, 1 exact first name, 2 name starts with the query
  // (first-name prefix or "ana r"), 3 a later word starts with it, 4 no match.
  rank(query, name) {
    if (name === query) return 0;
    const words = name.split(' ');
    if (words[0] === query) return 1;
    if (name.startsWith(query)) return 2;
    return words.slice(1).some(w => w.startsWith(query)) ? 3 : 4;
  },

  // Best matches first; within a rank, tonight's list, then more games played.
  suggest(query, people, limit = 6) {
    const q = Names.norm(query);
    if (!q) return [];
    return people
      .map(p => ({ p, rank: Names.rank(q, Names.norm(p.name)) }))
      .filter(x => x.rank < 4)
      .sort((a, b) => a.rank - b.rank || !!b.p.priority - !!a.p.priority
        || (b.p.games || 0) - (a.p.games || 0) || a.p.name.localeCompare(b.p.name))
      .slice(0, limit)
      .map(x => x.p);
  },

  // What typed text means: one known player, a choice between several who
  // share that first name (including someone saved under just that name), or
  // a new player. Prefixes never resolve on their own, so a new "Jo" is not
  // silently turned into "Jose".
  resolve(query, people) {
    const q = Names.norm(query);
    if (!q) return { fresh: '' };
    const exact = people.find(p => Names.norm(p.name) === q);
    const first = people.filter(p => Names.rank(q, Names.norm(p.name)) === 1);
    // a bare first name shared with others must not hide them: ask which one
    if (exact) return !q.includes(' ') && first.length ? { choices: [exact.name, ...first.map(p => p.name)] } : { name: exact.name };
    if (first.length === 1) return { name: first[0].name };
    if (first.length > 1) return { choices: first.map(p => p.name) };
    return { fresh: Names.clean(query) };
  },
};

if (typeof module !== 'undefined') module.exports = Names;
