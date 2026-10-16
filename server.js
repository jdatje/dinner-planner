const http = require('http'), fs = require('fs'), path = require('path');
const CODE = process.env.HOUSEHOLD_CODE || '';
const FILE = process.env.DATA_FILE || '/data/state.json';
let state = { rev: 0, plan: {}, shopping: [], recipes: null };
try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const save = () => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(state));
  fs.renameSync(FILE + '.tmp', FILE);
};
const manifest = JSON.stringify({ name: 'Dinner Planner', short_name: 'Dinner', start_url: '/', display: 'standalone',
  background_color: '#ffffff', theme_color: '#C8321F', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] });
const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#C8321F"/><circle cx="50" cy="52" r="26" fill="none" stroke="#fff" stroke-width="7"/><path d="M50 30v44M36 38v14a14 14 0 0 0 28 0V38" stroke="#fff" stroke-width="5" fill="none"/></svg>';
const KEY = process.env.ANTHROPIC_API_KEY || '', LIMIT = +process.env.AI_DAILY_LIMIT || 20;
let use = { day: '', n: 0 };
const SPICY = /chil[il]|cayenne|jalape|harissa|sriracha|tabasco|curry|wasabi|habanero|scotch bonnet|vindaloo|gochujang|peri.?peri/i;
const SHAPE = 'Reply with JSON only: {"name":string,"min":number,"ing":[string with amount],"steps":[string],"spicy":boolean}';
const body = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 3e7) req.destroy(); }); req.on('end', () => r(b)); });
async function ai(prompt) {
  if (!KEY) return { error: 'nokey' };
  const day = new Date().toISOString().slice(0, 10);
  if (use.day !== day) use = { day, n: 0 };
  if (use.n >= LIMIT) return { error: 'limit' };
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }) });
  const j = await r.json();
  if (!r.ok) return { error: /credit balance/i.test(JSON.stringify(j)) ? 'tokens' : 'err' };
  use.n++;
  try { return { recipe: JSON.parse(j.content[0].text.match(/\{[\s\S]*\}/)[0]) }; } catch { return { error: 'err' }; }
}
async function mealdb(have, kid) {
  for (let i = 0; i < 10; i++) {
    const m = (await (await fetch('https://www.themealdb.com/api/json/v1/1/random.php')).json()).meals[0];
    const ing = [];
    for (let n = 1; n <= 20; n++) { const a = (m['strIngredient' + n] || '').trim(); if (a) ing.push(((m['strMeasure' + n] || '').trim() + ' ' + a).trim()); }
    const spicy = SPICY.test(m.strMeal + ing.join(' '));
    if (['Dessert', 'Starter', 'Side', 'Breakfast'].includes(m.strCategory) || have.includes(m.strMeal) || (kid && spicy)) continue;
    return { recipe: { name: m.strMeal, min: 30, ing, steps: m.strInstructions.split(/\r?\n+/).map(s => s.trim()).filter(s => s.length > 1), img: m.strMealThumb, link: m.strSource || '', spicy, src: 'db' } };
  }
  return { error: 'err' };
}
const dur = s => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(s || ''); return m ? ((+m[1] || 0) * 60 + (+m[2] || 0)) || 30 : 30; };
const flat = x => Array.isArray(x) ? x.flatMap(flat) : x && x.itemListElement ? flat(x.itemListElement) : typeof x === 'string' ? x.split(/\n+/) : x && x.text ? [x.text] : [];
const find = n => Array.isArray(n) ? n.flatMap(find) : n && n['@graph'] ? find(n['@graph']) : [n];
async function importUrl(url) {
  if (!/^https?:\/\//.test(url)) return { error: 'err' };
  const html = await (await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })).text();
  for (const m of html.matchAll(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const r = find(JSON.parse(m[1])).find(x => x && [].concat(x['@type']).includes('Recipe'));
      if (!r) continue;
      const ing = r.recipeIngredient || [], img = [].concat(r.image || [])[0];
      return { recipe: { name: r.name, min: dur(r.totalTime), ing, steps: flat(r.recipeInstructions).map(s => s.replace(/<[^>]+>/g, '').trim()).filter(Boolean),
        img: typeof img === 'string' ? img : img && img.url, link: url, spicy: SPICY.test(r.name + ing.join(' ')), src: 'url' } };
    } catch {}
  }
  const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 12000);
  const j = await ai('Extract the recipe from this web page text. ' + SHAPE + '\n\n' + text);
  return j.recipe ? { recipe: { ...j.recipe, link: url, src: 'url' } } : j.error === 'nokey' ? { error: 'nofound' } : j;
}
http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/state') {
    if (!CODE || req.headers['x-code'] !== CODE) { res.writeHead(401); return res.end(); }
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(state)); }
    if (req.method === 'PUT') {
      let b = '';
      req.on('data', d => { b += d; if (b.length > 3e7) req.destroy(); });
      req.on('end', () => {
        try { state = { ...JSON.parse(b), rev: state.rev + 1 }; save(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ rev: state.rev })); }
        catch { res.writeHead(400); res.end(); }
      });
      return;
    }
  }
  if (req.method === 'POST' && (url === '/api/idea' || url === '/api/import')) {
    if (!CODE || req.headers['x-code'] !== CODE) { res.writeHead(401); return res.end(); }
    body(req).then(async b => {
      let out;
      try {
        const q = JSON.parse(b);
        out = url === '/api/import' ? await importUrl(q.url) : q.kind === 'db' ? await mealdb(q.have || [], q.kid)
          : await ai(`Invent one new family dinner recipe (about 30 minutes, ingredients from a Dutch supermarket). Liked: ${(q.liked || []).join(', ') || 'none yet'}. Avoid: ${(q.no || []).join(', ') || 'nothing'}. Do not repeat: ${(q.have || []).join(', ')}. ${q.kid ? 'Must not be spicy and must be kid-friendly.' : ''} ${SHAPE}`);
        if (out.recipe) out.recipe.src = out.recipe.src || 'ai';
      } catch { out = { error: 'err' }; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out));
    });
    return;
  }
  if (url === '/manifest.json') { res.setHeader('content-type', 'application/manifest+json'); return res.end(manifest); }
  if (url === '/icon.svg') { res.setHeader('content-type', 'image/svg+xml'); return res.end(icon); }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
}).listen(process.env.PORT || 3000);
