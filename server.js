'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const dns = require('dns').promises, net = require('net');

const CODE = process.env.HOUSEHOLD_CODE || '';
const FILE = process.env.DATA_FILE || '/data/state.json';
const DIR = path.dirname(FILE), USAGE_FILE = path.join(DIR, 'usage.json');
const KEY = process.env.ANTHROPIC_API_KEY || '', LIMIT = +process.env.AI_DAILY_LIMIT || 20;
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const PRICE_IN = +process.env.AI_PRICE_IN || 1, PRICE_OUT = +process.env.AI_PRICE_OUT || 5; // USD per million tokens (estimate)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/* ---------- state ---------- */
let state = { rev: 0 };
try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
if (typeof state.rev !== 'number') state.rev = 0;
let lastBak = 0;
function persist() {
  fs.mkdirSync(DIR, { recursive: true });
  if (Date.now() - lastBak > 864e5) { try { fs.copyFileSync(FILE, FILE + '.bak'); } catch {} lastBak = Date.now(); }
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(state));
  fs.renameSync(FILE + '.tmp', FILE);
}
let usage = { day: '', n: 0, inTok: 0, outTok: 0, spend: 0 };
try { usage = { ...usage, ...JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) }; } catch {}
const saveUsage = () => { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch {} };

/* ---------- login with lockout ---------- */
const fails = new Map();
const clientIp = req => { const x = String(req.headers['x-forwarded-for'] || ''); return (x.split(',').pop() || req.socket.remoteAddress || '').trim(); };
function authed(req, res) {
  const k = clientIp(req), now = Date.now(), f = fails.get(k) || { n: 0, t: 0, until: 0 };
  if (f.until > now) { res.writeHead(429, { 'retry-after': Math.ceil((f.until - now) / 1000) }); res.end(); return false; }
  const a = Buffer.from(String(req.headers['x-code'] || '')), b = Buffer.from(CODE);
  if (CODE && a.length === b.length && crypto.timingSafeEqual(a, b)) { fails.delete(k); return true; }
  if (now - f.t > 6e5) f.n = 0;
  f.n++; f.t = now;
  if (f.n >= 5) { f.until = now + 9e5; f.n = 0; }
  fails.set(k, f);
  res.writeHead(401); res.end();
  return false;
}

/* ---------- text helpers ---------- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', deg: '°', frac12: '½', frac14: '¼', frac34: '¾' };
const dec = s => String(s ?? '').replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
  return ENT[e.toLowerCase()] ?? m;
});
const strip = s => dec(String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();

const SPICY = /chil[ie]|chili|cayenne|jalape[nñ]o|harissa|sriracha|tabasco|sambal|pittig|rode peper|madame jeanette|habanero|scotch bonnet|vindaloo|gochujang|peri.?peri|curry|kerrie|wasabi/i;

/* ---------- metric conversion ---------- */
const FR = { '½': .5, '¼': .25, '¾': .75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': .125 };
const NUMRE = '(\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d+(?:[.,]\\d+)?\\s*[½¼¾⅓⅔⅛]?|[½¼¾⅓⅔⅛])';
function toNum(s) {
  s = s.trim(); let m;
  if (FR[s]) return FR[s];
  if ((m = /^(\d+)\s*([½¼¾⅓⅔⅛])$/.exec(s))) return +m[1] + FR[m[2]];
  if ((m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s))) return +m[1] + m[2] / m[3];
  if ((m = /^(\d+)\/(\d+)$/.exec(s))) return m[1] / m[2];
  return parseFloat(s.replace(',', '.'));
}
const CUPG = [[/powdered sugar|icing sugar|confectioner/i, 120], [/brown sugar/i, 210], [/flour|bloem/i, 125], [/sugar|suiker/i, 200], [/butter|boter/i, 227], [/rice|rijst/i, 185], [/oats|havermout/i, 90], [/honey|honing/i, 340], [/cocoa|cacao/i, 85], [/breadcrumbs|paneermeel/i, 110], [/parmesan|grated cheese/i, 100]];
const CUPML = /milk|water|stock|broth|juice|cream|buttermilk|wine|oil|vinegar|yoghurt|yogurt/i;
const rnd = n => n >= 100 ? Math.round(n / 5) * 5 : n >= 20 ? Math.round(n) : Math.round(n * 10) / 10;
const UNITRE = new RegExp('(?<![\\d./,])' + NUMRE + '\\s*(fl\\.?\\s?oz|cups?|tablespoons?|tbsps?|tbs|teaspoons?|tsps?|ounces?|oz|pounds?|lbs?)(?![a-z])', 'i');
function metric(line) {
  if (/\(\s*[≈~]?\s*\d[\d.,]*\s*(g|kg|ml|l|cl|dl)\b/i.test(line)) return line;
  return line.replace(UNITRE, (m, q, u) => {
    const n = toNum(q); if (!(n > 0)) return m;
    u = u.toLowerCase().replace(/[\s.]/g, ''); let out;
    if (/^fl/.test(u)) out = `≈ ${rnd(n * 29.6)} ml`;
    else if (/^(tablespoon|tbsp|tbs)/.test(u)) out = `${rnd(n * 15)} ml`;
    else if (/^(teaspoon|tsp)/.test(u)) out = `${rnd(n * 5)} ml`;
    else if (/^(ounce|oz)/.test(u)) out = `≈ ${rnd(n * 28.35)} g`;
    else if (/^(pound|lb)/.test(u)) { const g = n * 453.6; out = g >= 1000 ? `≈ ${Math.round(g / 100) / 10} kg` : `≈ ${rnd(g)} g`; }
    else {
      const hit = CUPG.find(([r]) => r.test(line));
      if (hit) out = `≈ ${rnd(n * hit[1])} g`; else if (CUPML.test(line)) out = `≈ ${rnd(n * 240)} ml`; else return m;
    }
    return `${m} (${out})`;
  });
}
function fahr(s) {
  if (/°\s?C|celsius/i.test(s)) return s;
  return s.replace(/(\d{3})\s?(?:°|degrees)?\s?F\b/g, (m, n) => `${m} (≈ ${Math.round((n - 32) * 5 / 9 / 5) * 5} °C)`);
}

/* ---------- recipe parsing ---------- */
const flat = x => Array.isArray(x) ? x.flatMap(flat) : x && x.itemListElement ? flat(x.itemListElement) : typeof x === 'string' ? [x] : x && x.text ? [x.text] : x && x.name ? [x.name] : [];
const findR = n => Array.isArray(n) ? n.flatMap(findR) : n && typeof n === 'object' ? (n['@graph'] ? findR(n['@graph']) : [n]) : [];
function minutes(s) {
  const m = /P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(String(s || ''));
  return m ? (+m[1] || 0) * 60 + (+m[2] || 0) : 0;
}
function fin(r, link, src) {
  const ing = (r.ing || []).map(s => metric(strip(s))).filter(Boolean);
  const steps = (r.steps || []).map(s => fahr(strip(s))).filter(Boolean);
  const name = strip(r.name || '').slice(0, 120);
  return { name, min: Math.round(+r.min || 0), serv: Math.round(+r.serv || 0) || 0, ing, steps, img: r.img || '', link: link || '',
    spicy: !!r.spicy || SPICY.test(name + ' ' + ing.join(' ')), src, cat: r.cat || [] };
}
function parseRecipe(html, url) {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let j; try { j = JSON.parse(m[1].trim()); } catch { continue; }
    const r = findR(j).find(x => x && [].concat(x['@type'] || []).includes('Recipe'));
    if (!r) continue;
    const img = [].concat(r.image || [])[0];
    const yieldN = (String([].concat(r.recipeYield || [])[0] || '').match(/\d+/) || [0])[0];
    const min = minutes(r.totalTime) || (minutes(r.prepTime) + minutes(r.cookTime));
    const steps = flat(r.recipeInstructions).flatMap(s => strip(s).split(/\n+/));
    const cat = [].concat(r.recipeCategory || [], r.recipeCuisine || []).flatMap(c => String(c).split(',')).map(c => strip(c).toLowerCase()).filter(Boolean);
    const out = fin({ name: r.name, min, serv: yieldN, ing: [].concat(r.recipeIngredient || []), steps, img: typeof img === 'string' ? img : img && img.url, cat }, url, 'url');
    if (out.name && (out.ing.length || out.steps.length)) return out;
  }
  return null;
}

/* ---------- page discovery for bulk import ---------- */
function anchors(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)) {
    let u; try { u = new URL(dec(m[2]), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    u.hash = '';
    out.push({ u, url: u.href, text: strip(m[4]).replace(/\s+/g, ' ').slice(0, 60), attrs: m[1] + ' ' + m[3] });
  }
  return out;
}
const CATW = /recept|recipe|categor|gerecht|gang|course|collectie|collection|keuken|cuisine|diner|dinner|lunch|ontbijt|breakfast|dessert|nagerecht|drank|drink|bbq|soep|soup|salade|pasta|vlees|vis|vega|snack|bijgerecht|hoofdgerecht/i;
function recipeLinks(html, base) {
  const bu = new URL(base);
  let part = (html.match(/<article\b[\s\S]*?<\/article>/gi) || []).join('\n');
  if (!part) part = (html.match(/<main\b[\s\S]*?<\/main>/i) || [html])[0];
  const seen = new Map();
  for (const a of anchors(part, base)) {
    if (a.u.host !== bu.host) continue;
    a.u.search = '';
    const p = a.u.pathname;
    if (p === '/' || p === bu.pathname) continue;
    if (/\.(jpe?g|png|gif|webp|svg|pdf|css|js)$/i.test(p) || /\/(page|pagina)\/\d+|\/(tag|tags|category|categorie|author|feed|wp-[a-z]+|contact|over-mij|zoeken|search)(\/|$)/i.test(p)) continue;
    const slug = p.split('/').filter(Boolean).pop() || '';
    if (slug.length < 6) continue;
    if (!seen.has(a.u.href)) seen.set(a.u.href, a.text.length >= 3 ? a.text : slug.replace(/-/g, ' '));
  }
  return [...seen].map(([url, name]) => ({ url, name }));
}
function discoverFrom(html, url) {
  const b = new URL(url), seen = new Set([b.href]), cats = [];
  const nav = html.replace(/<article\b[\s\S]*?<\/article>/gi, ' ');
  for (const a of anchors(nav, url)) {
    if (a.u.host !== b.host || seen.has(a.url)) continue;
    const segs = a.u.pathname.split('/').filter(Boolean);
    const filter = a.u.pathname === b.pathname && a.u.search && a.u.search !== b.search;
    const looks = segs.length >= 1 && segs.length <= 3 && CATW.test(a.u.pathname + a.u.search) && !/page\/\d|[?&]p(aged?)?=\d/i.test(a.url);
    if (!(filter || looks)) continue;
    const name = a.text;
    if (!name || name.length < 2 || name.length > 30 || /^\d+$/.test(name)) continue;
    seen.add(a.url); cats.push({ name, url: a.url });
  }
  const t = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  return { host: b.host, title: strip(t || ''), categories: cats.slice(0, 40), count: recipeLinks(html, url).length };
}
function nextPage(html, url) {
  let m = html.match(/<link[^>]+rel=["']next["'][^>]*href=["']([^"']+)["']/i) || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']next["']/i);
  if (m) { try { return new URL(dec(m[1]), url).href; } catch { return null; } }
  const all = anchors(html, url);
  const a = all.find(x => /rel=["'][^"']*next/i.test(x.attrs) || /class=["'][^"']*\bnext\b/i.test(x.attrs));
  if (a) return a.url;
  const cur = +((url.match(/\/page\/(\d+)/) || url.match(/[?&](?:paged?|pagina|p)=(\d+)/) || [0, 1])[1]);
  const want = cur + 1;
  const re = new RegExp(`/page/${want}(/|$|\\?)|[?&](?:paged?|pagina|p)=${want}(&|$)`);
  const b = all.find(x => re.test(x.url));
  return b ? b.url : null;
}
function listFrom(html, url) { return { items: recipeLinks(html, url), next: nextPage(html, url) }; }

/* ---------- fetching other sites (never our own network) ---------- */
function isPrivate(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || (l.startsWith('::ffff:') && isPrivate(l.slice(7))); }
  return true;
}
async function safe(u) {
  const x = new URL(u);
  if (!/^https?:$/.test(x.protocol)) throw new Error('bad url');
  if (process.env.ALLOW_PRIVATE_FETCH !== '1') {
    const addrs = net.isIP(x.hostname) ? [{ address: x.hostname }] : await dns.lookup(x.hostname, { all: true });
    if (!addrs.length || addrs.some(a => isPrivate(a.address))) throw new Error('blocked');
  }
  return x.href;
}
async function getHtml(url) {
  let u = url;
  for (let i = 0; i < 4; i++) {
    u = await safe(u);
    const c = new AbortController(), t = setTimeout(() => c.abort(), 15000);
    try {
      const r = await fetch(u, { signal: c.signal, redirect: 'manual', headers: { 'user-agent': UA, 'accept-language': 'nl,en;q=0.8', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'upgrade-insecure-requests': '1' } });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u).href; continue; }
      if (!r.ok) throw new Error('http ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 5e6) throw new Error('too big');
      return buf.toString('utf8');
    } finally { clearTimeout(t); }
  }
  throw new Error('redirects');
}

// page given by the user's own browser (for sites that block the server), or fetched here
async function pageHtml(q) {
  const raw = String(q.url || '');
  if (q.html) { const x = new URL(raw); if (!/^https?:$/.test(x.protocol)) throw new Error('bad url'); return [String(q.html).slice(0, 5e6), x.href]; }
  const u = await safe(raw); return [await getHtml(u), u];
}

/* ---------- AI (optional) ---------- */
const SHAPE = 'Reply with JSON only, no other text: {"name":string,"min":number,"serv":number,"ing":[string with amount],"steps":[string],"spicy":boolean}. Use metric units (g, ml, EL, TL).';
async function ai(content, maxTok = 1800) {
  if (!KEY) return { error: 'nokey' };
  const day = new Date().toISOString().slice(0, 10);
  if (usage.day !== day) { usage.day = day; usage.n = 0; }
  if (usage.n >= LIMIT) return { error: 'limit' };
  let r, j;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTok, messages: [{ role: 'user', content }] }) });
    j = await r.json();
  } catch { return { error: 'err' }; }
  if (!r.ok) return { error: /credit balance|billing/i.test(JSON.stringify(j)) ? 'tokens' : 'err' };
  const tin = (j.usage && j.usage.input_tokens) || 0, tout = (j.usage && j.usage.output_tokens) || 0;
  usage.n++; usage.inTok += tin; usage.outTok += tout; usage.spend += (tin * PRICE_IN + tout * PRICE_OUT) / 1e6; saveUsage();
  try { return { recipe: JSON.parse(((j.content && j.content[0] && j.content[0].text) || '').match(/\{[\s\S]*\}/)[0]) }; } catch { return { error: 'err' }; }
}
const langName = l => l === 'nl' ? 'Dutch' : 'English';
async function importUrl(url, lang, given) {
  if (given && !/^https?:\/\//i.test(url)) throw new Error('bad url');
  const html = given ? String(given).slice(0, 5e6) : await getHtml(url);
  const r = parseRecipe(html, url);
  if (r) return { recipe: r };
  if (!KEY) return { error: 'nofound' };
  const text = strip(html.replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')).replace(/\s+/g, ' ').slice(0, 12000);
  const j = await ai('Extract the recipe from this web page text. If there is no recipe, reply {"name":"","ing":[],"steps":[]}. Write in ' + langName(lang) + '. ' + SHAPE + '\n\n' + text);
  if (!j.recipe) return j;
  const og = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || [])[1];
  const out = fin({ ...j.recipe, img: og ? dec(og) : '' }, url, 'url');
  return out.name && out.ing.length ? { recipe: out } : { error: 'nofound' };
}

/* ---------- http ---------- */
const INDEX = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const BUILD = crypto.createHash('sha1').update(INDEX).digest('hex').slice(0, 10);
const ICON = n => path.join(__dirname, 'icons', n);
const PNG = { '/icon-180.png': 'icon-180.png', '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png', '/add-192.png': 'add-192.png', '/add-512.png': 'add-512.png' };
const manifest = (id, name, start, icon) => JSON.stringify({ id, name, short_name: name, start_url: start, scope: start, display: 'standalone', background_color: '#ffffff', theme_color: '#C8321F',
  icons: [{ src: `/${icon}-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: `/${icon}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' }] });
const send = (res, code, body, type = 'application/json', extra = {}) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = req => new Promise((ok, no) => {
  let b = ''; req.on('data', d => { b += d; if (b.length > 3e7) { req.destroy(); no(new Error('big')); } });
  req.on('end', () => ok(b)); req.on('error', no);
});

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (req.method === 'GET') {
      if (url === '/' || url === '/add') return send(res, 200, INDEX.replace('__BUILD__', BUILD), 'text/html; charset=utf-8');
      if (url === '/manifest.json') return send(res, 200, manifest('/', 'Dinner Planner', '/', 'icon'), 'application/manifest+json');
      if (url === '/add-manifest.json') return send(res, 200, manifest('/add', 'Add recipe', '/add', 'add'), 'application/manifest+json');
      if (PNG[url]) { try { return send(res, 200, fs.readFileSync(ICON(PNG[url])), 'image/png', { 'cache-control': 'public, max-age=86400' }); } catch { return send(res, 404, ''); } }
      if (url === '/icon.svg') return send(res, 200, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#C8321F"/><circle cx="50" cy="52" r="26" fill="none" stroke="#fff" stroke-width="7"/></svg>', 'image/svg+xml');
    }
    if (!url.startsWith('/api/')) return send(res, 404, '');
    if (!authed(req, res)) return;
    if (req.method === 'GET' && url === '/api/rev') return send(res, 200, { rev: state.rev, build: BUILD });
    if (req.method === 'GET' && url === '/api/state') return send(res, 200, { ...state, build: BUILD });
    if (req.method === 'GET' && url === '/api/usage') {
      const today = new Date().toISOString().slice(0, 10);
      return send(res, 200, { n: usage.day === today ? usage.n : 0, limit: LIMIT, inTok: usage.inTok, outTok: usage.outTok, spend: usage.spend, hasKey: !!KEY });
    }
    if (req.method === 'PUT' && url === '/api/state') {
      const b = JSON.parse(await readBody(req));
      for (const k of Object.keys(b)) if (k !== 'rev' && k !== 'build') state[k] = b[k];
      state.rev++; persist();
      return send(res, 200, { rev: state.rev });
    }
    if (req.method === 'POST') {
      const q = JSON.parse(await readBody(req) || '{}');
      let out;
      try {
        if (url === '/api/import') out = await importUrl(String(q.url || ''), q.lang, q.html);
        else if (url === '/api/discover') { const [html, u] = await pageHtml(q); out = discoverFrom(html, u); }
        else if (url === '/api/list') { const [html, u] = await pageHtml(q); out = listFrom(html, u); }
        else if (url === '/api/idea') {
          const j = await ai(`Invent one new family dinner recipe (about 30 minutes, ingredients from a Dutch supermarket) for 4 people. Write in ${langName(q.lang)}. Liked: ${(q.liked || []).join(', ') || 'none yet'}. Avoid: ${(q.no || []).join(', ') || 'nothing'}. Do not repeat: ${(q.have || []).join(', ')}. ${q.kid ? 'Must not be spicy and must be kid-friendly.' : ''} ${SHAPE}`);
          out = j.recipe ? { recipe: fin({ serv: 4, ...j.recipe }, '', 'ai') } : j;
        } else if (url === '/api/ocr') {
          const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(q.image || ''));
          if (!m) out = { error: 'err' };
          else {
            const j = await ai([{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
              { type: 'text', text: 'Transcribe the recipe in this photo exactly as written (do not invent anything). Write in ' + langName(q.lang) + ' unless the recipe is in another language, then keep that language. ' + SHAPE }], 2500);
            out = j.recipe ? { recipe: fin(j.recipe, '', 'scan') } : j;
          }
        } else return send(res, 404, '');
      } catch (e) { const m = String(e && e.message || e); console.error('fetch fail', url, m); out = { error: /blocked|bad url|Invalid URL/i.test(m) ? 'badurl' : 'err', detail: m.slice(0, 80) }; }
      return send(res, 200, out);
    }
    send(res, 404, '');
  } catch { try { send(res, 500, { error: 'err' }); } catch {} }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000, HOST = process.env.HOST || '127.0.0.1';
  server.listen(PORT, HOST, () => console.log(`Dinner planner on ${HOST}:${PORT} (build ${BUILD})`));
} else module.exports = { metric, fahr, parseRecipe, discoverFrom, listFrom, nextPage, recipeLinks, isPrivate, dec, strip, server };
