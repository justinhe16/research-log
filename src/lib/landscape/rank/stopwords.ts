/*
 * Stopwords for lexical ranking and key-term extraction: common English function
 * words plus boilerplate that shows up in nearly every abstract ("we propose a
 * novel approach ... results show") and so carries no topical signal.
 * Entries are lowercase, unstemmed surface forms; the tokenizer checks a token
 * against this set before stemming it.
 */

const ENGLISH = `
a about above after again against all almost also although always am among an and any
are aren't around as at be became because become becomes been before being below between
both but by can cannot could couldn't did didn't do does doesn't doing don't done down
during each either else etc even ever every few for from further had hadn't has hasn't
have haven't having he her here hers herself him himself his how however i if in into is
isn't it it's its itself just least less let like made mainly make makes many may me might
more most mostly much must my myself neither no nor not now of off often on once one only
onto or other others otherwise our ours ourselves out over own per perhaps quite rather
really same several shall she should shouldn't since so some such than that the their
theirs them themselves then there thereby therefore these they this those though through
thus to too toward towards under until up upon us use used uses using very via was wasn't
we well were weren't what when where whether which while who whom whose why will with
within without would wouldn't yet you your yours yourself yourselves
`;

const ACADEMIC = `
abstract achieve achieved achieves approach approaches article based conduct conducted
contribution contributions demonstrate demonstrated demonstrates effective effectively
evaluate evaluated experiment experimental experiments extensive finally find findings
first furthermore introduce introduced introduces method methods moreover new novel
outperform outperforms paper papers present presented presents problem propose proposed
proposes provide provided provides recent recently result results second show showed
shown shows significant significantly state-of-the-art study studies studied superior
technique techniques three two various work works
`;

function toSet(...lists: string[]): ReadonlySet<string> {
  return new Set(lists.flatMap((l) => l.split(/\s+/).filter(Boolean)));
}

export const STOPWORDS: ReadonlySet<string> = toSet(ENGLISH, ACADEMIC);

export function isStopword(word: string): boolean {
  return STOPWORDS.has(word);
}
