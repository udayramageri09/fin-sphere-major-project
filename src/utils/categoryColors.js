// A stable colour for each category name (so Food is the same colour in every chart and period). Colour is never the only cue: every
// chart also writes the names and figures out in text.
// Low-chroma blue, sage and warm-neutral accents; labels and tables carry meaning as well as colour.
const FIXED = {
  Food: '#71867a', Shopping: '#60788d', Bills: '#40566d', Entertainment: '#8c8196', Travel: '#a18a70', Investment: '#516c68', Salary: '#687e70', Others: '#8b9199'
};
const EXTRA = ['#60788d', '#71867a', '#a18a70', '#8c8196', '#516c68', '#7a8493'];

export function colorFor(name) {
  if (FIXED[name]) return FIXED[name];
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return EXTRA[hash % EXTRA.length];
}
