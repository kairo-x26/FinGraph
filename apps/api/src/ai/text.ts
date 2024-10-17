const STOPWORDS = new Set(
  `a an and are as at be been but by can could did do does for from had has have how i if in into is it its
   of on or our over shall should so such than that the their them then there these they this those to under
   up was we were what when where which while who whom whose why will with would you your any all also about
   listed list please tell show give documents document company case`.split(/\s+/),
);

/** Very light English stemmer: enough to match owner/owners/ownership. */
export function stem(word: string): string {
  let w = word;
  for (const suffix of ['ship', 'ings', 'ing', 'ies', 'ers', 'ed', 'es', 's']) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      w = suffix === 'ies' ? `${w.slice(0, -3)}y` : w.slice(0, -suffix.length);
      break;
    }
  }
  if (w.endsWith('er') && w.length > 4) w = w.slice(0, -2);
  return w;
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9%.]*[a-z0-9%]/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function terms(text: string): string[] {
  return tokens(text).map(stem);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.replace(/\s{2,}/g, ' ').trim())
    .filter((s) => s.length > 2);
}
