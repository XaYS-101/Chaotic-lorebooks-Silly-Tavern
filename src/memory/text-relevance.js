// text-relevance.js — lightweight relevance math, NO LLM: tokenization with
// stopwords (en+ru), Jaccard (scene shift) and BM25 (resurfacing/relevance).
// 🟢 instant and deterministic.

const STOP = new Set([
  // en
  'the','and','for','that','with','this','from','have','was','were','are','you','your',
  'but','not','his','her','she','him','they','them','their','what','when','then','than',
  'into','about','just','like','will','would','could','should','been','because','very',
  // ru
  'это','что','как','так','вот','где','этот','эта','его','её','ему','они','их','том','там',
  'был','была','было','были','чтобы','если','когда','тоже','уже','еще','ещё','для','над',
  'под','при','без','про','или','либо','тебя','меня','себя','свой','она','оно','они',
]);

/** Lightweight Russian stemmer (simplified Snowball/Porter): strips endings so
 *  «Рену/Реном/Рена» → «рен». Covers cases and verb forms. */
function stemRu(w) {
  w = w.toLowerCase().replace(/ё/g, 'е');
  const i = w.search(/[аеиоуыэюя]/);
  if (i < 0) return w;
  const head = w.slice(0, i + 1);
  let rv = w.slice(i + 1);

  // Step 1: perfective gerund / reflexive / adjective / participle / verb / noun
  let s1 = false;
  if (/[ая](вши|вшись|в)$/.test(rv)) { rv = rv.replace(/(вши|вшись|в)$/, ''); s1 = true; }
  else if (/(ивши|ившись|ывши|ывшись|ив|ыв)$/.test(rv)) { rv = rv.replace(/(ивши|ившись|ывши|ывшись|ив|ыв)$/, ''); s1 = true; }
  if (!s1) {
    rv = rv.replace(/(ся|сь)$/, '');
    const adj = /(ее|ие|ые|ое|ими|ыми|ей|ий|ый|ой|ем|им|ым|ом|его|ого|ему|ому|их|ых|ую|юю|ая|яя|ою|ею)$/;
    if (adj.test(rv)) {
      rv = rv.replace(adj, '');
      if (/[ая](ем|нн|вш|ющ|щ)$/.test(rv)) rv = rv.replace(/(ем|нн|вш|ющ|щ)$/, '');
      else rv = rv.replace(/(ивш|ывш|ующ)$/, '');
      s1 = true;
    } else if (/[ая](ла|на|ете|йте|ли|й|л|ем|н|ло|но|ет|ют|ны|ть|ешь|нно)$/.test(rv)) {
      rv = rv.replace(/(ла|на|ете|йте|ли|й|л|ем|н|ло|но|ет|ют|ны|ть|ешь|нно)$/, ''); s1 = true;
    } else {
      const verb2 = /(ила|ыла|ена|ейте|уйте|ите|или|ыли|ей|уй|ил|ыл|им|ым|ен|ило|ыло|ено|ят|ует|уют|ит|ыт|ены|ить|ыть|ишь|ую|ю)$/;
      if (verb2.test(rv)) { rv = rv.replace(verb2, ''); s1 = true; }
      else { rv = rv.replace(/(а|ев|ов|ие|ье|е|иями|ями|ами|еи|ии|и|ией|ей|ой|ий|й|иям|ям|ием|ем|ам|ом|о|у|ах|иях|ях|ы|ь|ию|ью|ю|ия|ья|я)$/, ''); }
    }
  }
  rv = rv.replace(/и$/, '');                 // Step 2
  rv = rv.replace(/(ость|ост)$/, '');        // Step 3
  if (/нн$/.test(rv)) rv = rv.replace(/н$/, ''); // Step 4
  else { rv = rv.replace(/(ейше|ейш)$/, ''); rv = rv.replace(/ь$/, ''); }
  return head + rv;
}

/** Lightweight English stemmer: conservative stripping of common suffixes. */
function stemEn(w) {
  w = w.toLowerCase();
  if (w.length <= 4) return w;
  for (const suf of ['ization', 'iveness', 'fulness', 'ousness', 'ational', 'ation',
    'ments', 'ment', 'ness', 'ing', 'edly', 'ied', 'ies', 'ed', 'es', 'ly', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
  }
  return w;
}

/** Stem by alphabet (Cyrillic → ru, else en). Normalizes cases, NO LLM. */
export function stem(w) {
  if (isProperNoun(w)) return w.toLowerCase();
  return /[а-яё]/i.test(w) ? stemRu(w) : stemEn(w);
}

/**
 * Proper-noun detector: word starts uppercase but is NOT all-caps (acronyms like
 * NATO, FBI, КГБ aren't names). Returns true if the word looks like a proper noun
 * that should NOT be stemmed (only lowercased).
 *
 * Self-calibrating — uses no name dictionaries.
 */
export function isProperNoun(w) {
  if (!w || typeof w !== 'string') return false;
  // Must start with an uppercase letter.
  if (!/^[A-ZА-ЯЁ]/.test(w)) return false;
  // If MOST letters are uppercase, it's an acronym (NATO, FBI, USA, КГБ, СССР).
  const upper = (w.match(/[A-ZА-ЯЁ]/g) || []).length;
  if (upper > w.length * 0.5) return false;
  return true;
}

/** Content tokens: lowercased, no stopwords, longer than 3 chars, STEMMED. */
export function contentTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3 && !STOP.has(w))
    .map(stem);
}

/** Fraction of shared unique words (0..1). For the scene detector. */
export function jaccard(aTokens, bTokens) {
  const A = new Set(aTokens), B = new Set(bTokens);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * IDF over a corpus of token-docs (doc = one message). Returns an idf(token)
 * function. IDF is computed FROM the chat itself → self-calibrating (no external
 * dictionaries/names), setting-invariant. BM25 formula: ln(1+(N−df+0.5)/(df+0.5)).
 */
export function buildIdf(docsTokens) {
  const N = (docsTokens?.length) || 1;
  const df = new Map();
  for (const d of (docsTokens || [])) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  return (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
}

/**
 * Cosine between two token lists under tf·idf weighting (0..1). Unlike Jaccard,
 * rare/topical words get weight and ubiquitous ones are damped → detects a TOPIC
 * SHIFT, not lexical churn (Jaccard on a sparse bag saturates ~0.2-0.3, near-useless).
 */
export function tfidfCosine(aTokens, bTokens, idf) {
  const vec = (toks) => {
    const m = new Map();
    for (const t of (toks || [])) m.set(t, (m.get(t) || 0) + 1);
    for (const [t, tf] of m) m.set(t, tf * idf(t));
    return m;
  };
  const A = vec(aTokens), B = vec(bTokens);
  let dot = 0, na = 0, nb = 0;
  for (const [, w] of A) na += w * w;
  for (const [t, w] of B) { nb += w * w; const wa = A.get(t); if (wa) dot += w * wa; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * BM25 ranking of documents against a query. Returns [{doc, score}] descending.
 * docs: [{ tokens:string[], ... }]. query: string[].
 */
export function bm25Rank(queryTokens, docs, { k1 = 1.5, b = 0.75 } = {}) {
  const N = docs.length || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1);
  const avgdl = (docs.reduce((s, d) => s + d.tokens.length, 0) / N) || 1;
  const q = new Set(queryTokens);

  return docs.map((d) => {
    const tf = new Map();
    for (const t of d.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t); if (!f) continue;
      const n = df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.tokens.length / avgdl)));
    }
    return { doc: d, score };
  }).sort((a, b2) => b2.score - a.score);
}
