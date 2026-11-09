// Reads match details out of text posted in the match channel.
// Recognised lines (any order, bold/markdown ok):  Commentators: A, B | Commentator 1: A | Commentator 2: B
//   Team 1: X | Team 2: Y | Teams: X vs Y | Ref: Z | Caster: W
const clean = (s) => String(s).replace(/[*_`~]/g, '').trim().replace(/^@/, '').trim();
const splitNames = (s) => s.split(/\s*(?:,|&|\band\b|\/|\+)\s*/i).map(clean).filter(Boolean);

function parseMatchText(text, out) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[*_`~]/g, '').replace(/^[\s>•-]+/, '').trim();
    let m;
    if ((m = line.match(/^commentators?\s*#?\s*([12])\s*[:–-]\s*(.+)$/i))) { out.comm[Number(m[1]) - 1] ??= clean(m[2]); }
    else if ((m = line.match(/^commentators?\s*[:–-]\s*(.+)$/i))) { splitNames(m[1]).forEach((n, i) => { out.comm[i] ??= n; }); }
    else if ((m = line.match(/^team\s*([12])\s*[:–-]\s*(.+)$/i))) { out['team' + m[1]] ??= clean(m[2]); }
    else if ((m = line.match(/^(?:teams?|match|matchup)\s*[:–-]\s*(.+?)\s+(?:vs\.?|v\.?|versus)\s+(.+)$/i))) { out.team1 ??= clean(m[1]); out.team2 ??= clean(m[2]); }
    else if ((m = line.match(/^(?:refs?|referees?)\s*[:–-]\s*(.+)$/i))) { out.ref ??= clean(m[1]); }
    else if ((m = line.match(/^casters?\s*[:–-]\s*(.+)$/i))) { out.caster ??= clean(m[1]); }
  }
  return out;
}
module.exports = { parseMatchText };
