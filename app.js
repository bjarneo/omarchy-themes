"use strict";

/* Filter facet hues. These are display swatches for the sidebar dots and
   the heatmap bars; they are not the wallpaper's own colors. */
const COLOR_DOTS = {
  red:'#e74c5b', orange:'#f5994f', yellow:'#f0d869', green:'#7bbf6f',
  cyan:'#5ec3d0', blue:'#6d8fee', purple:'#a87cd9', pink:'#e88abf',
  monochrome:'#9aa0ab',
};
const TONE_DOTS = { dark: '#3b4261', light: '#d6dbef' };
const COLOR_ORDER = ['monochrome','red','orange','yellow','green','cyan','blue','purple','pink'];
const RES_TIERS = ['<=720p','720p','1080p','1440p','4K','5K','8K+'];

/* Reference scheme keys in the manifest map to user-facing variant labels.
   The mapping intentionally hides the source-scheme identity; each variant's
   palette is wallpaper-derived. */
const VARIANT_ORDER = ['palette', 'gruvbox', 'nord', 'material', 'aether'];
const VARIANT_LABEL = {
  'palette': 'Palette', 'gruvbox': 'Warm', 'nord': 'Cool', 'material': 'Material', 'aether': 'Aether',
};
const HUE_BY_SCHEME = {
  'palette': 'var(--red)', 'gruvbox': 'var(--orange)', 'nord': 'var(--cyan)',
  'material': 'var(--green)', 'aether': 'var(--magenta)',
};

/* ANSI slots in their canonical 0..15 order. Every variant carries all 16. */
const ANSI_KEYS = [
  'color0','color1','color2','color3','color4','color5','color6','color7',
  'color8','color9','color10','color11','color12','color13','color14','color15',
];

const STATE = {
  entries: [],
  byPath: {},
  filtered: [],
  // res_min / res_max are tier names from RES_TIERS. Either can be set alone
  // (open-ended bound) or together (range).
  filters: { tone: null, color: null, res_min: null, res_max: null, q: '' },
  facetCounts: {},
  rendered: 0,
  pageSize: 80,
  mask: null,        // Uint8Array: 1 if entry index passes the current filter
  firstPaint: true,  // gate the one-time reveal cascade to the first batch
  featured: null,    // 3 random entries (distinct colors), re-rolled each visit
  favs: null,        // Set<path> of favourited themes, persisted to localStorage
  favOnly: false,    // when true, show only favourited themes
};

const FILTER_KEYS = ['tone','color','res_min','res_max'];

/* ---- URL state ----------------------------------------------------- */
function readUrl() {
  const sp = new URLSearchParams(location.search);
  for (const k of FILTER_KEYS) STATE.filters[k] = sp.get(k) || null;
  STATE.filters.q = sp.get('q') || '';
  STATE.favOnly = sp.get('fav') === '1';
}
function buildUrl({ withHash = true } = {}) {
  const sp = new URLSearchParams();
  for (const k of FILTER_KEYS) if (STATE.filters[k]) sp.set(k, STATE.filters[k]);
  if (STATE.filters.q) sp.set('q', STATE.filters.q);
  if (STATE.favOnly) sp.set('fav', '1');
  const qs = sp.toString();
  const hash = withHash ? location.hash : '';
  return location.pathname + (qs ? '?' + qs : '') + hash;
}
function writeUrl() { history.replaceState(history.state, '', buildUrl()); }
function encodePath(p) { return p.split('/').map(encodeURIComponent).join('/'); }
function decodeHashPath() {
  if (!location.hash) return null;
  try { return decodeURIComponent(location.hash.slice(1)); } catch { return null; }
}

/* ---- tiny DOM helpers ---------------------------------------------- */
const $ = (s) => document.querySelector(s);
const grid = $('#grid');
const filtersEl = $('#filters');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function bucketRes(w, h) {
  if (!w || !h) return null;
  if (w >= 7000) return '8K+';
  if (w >= 4800) return '5K';
  if (w >= 3500) return '4K';
  if (w >= 2500) return '1440p';
  if (w >= 1900) return '1080p';
  if (w >= 1200) return '720p';
  return '<=720p';
}

/* ---- color math (for reactive --chip hue + swatch ink) ------------- */
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
}
// Relative luminance (0..1), sRGB. Used to pick contrast ink and clamp hues.
function luminance(rgb) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
  return 0.2126*f(rgb.r) + 0.7152*f(rgb.g) + 0.0722*f(rgb.b);
}
function saturation(rgb) {
  const r = rgb.r/255, g = rgb.g/255, b = rgb.b/255;
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b), l = (mx+mn)/2;
  if (mx === mn) return 0;
  const d = mx - mn;
  return l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
}
// Ink color that reads on a given swatch background.
function contrastInk(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#f2f4ff';
  return luminance(rgb) > 0.45 ? '#0b0b14' : '#f2f4ff';
}
/* The reactive per-card hue: the most-saturated mid-luminance swatch in the
   wallpaper's own extracted palette. NOT a fixed index - the array is
   variable length (6..16) and a fixed index like colors[8] is near-black for
   ~11% of entries, which would make the glow invisible. Falls back to the
   facet hue, then the brand accent. */
function pickDominant(colors, fallback) {
  let best = null, bestScore = -1;
  if (Array.isArray(colors)) {
    for (const hex of colors) {
      const rgb = hexToRgb(hex);
      if (!rgb) continue;
      const l = luminance(rgb), s = saturation(rgb);
      if (l < 0.16 || l > 0.85) continue;       // skip near-black / near-white
      const score = s + (1 - Math.abs(l - 0.5)) * 0.35;
      if (score > bestScore) { bestScore = score; best = hex; }
    }
  }
  if (best) return best;
  // No usable mid-tone: take the most saturated of any tone.
  if (Array.isArray(colors)) {
    for (const hex of colors) {
      const rgb = hexToRgb(hex); if (!rgb) continue;
      const s = saturation(rgb);
      if (s > bestScore) { bestScore = s; best = hex; }
    }
  }
  return best || fallback || '#7aa2f7';
}
/* A wallpaper's extracted palette as a single hard-stop gradient. Built from
   colors.length so it never renders a blank cell, however many colors exist. */
function rampGradient(colors) {
  if (!Array.isArray(colors) || !colors.length) return 'var(--bg-elev-2)';
  const n = colors.length;
  const stops = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n * 100).toFixed(3), b = ((i + 1) / n * 100).toFixed(3);
    stops.push(`${colors[i]} ${a}% ${b}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/* ---- media base url ------------------------------------------------ */
const MEDIA_BASE = (window.WALLPAPERS_BASE_URL || '').replace(/\/+$/, '');
function mediaUrl(p) {
  if (!p) return p;
  if (/^(https?:|data:|blob:)/i.test(p)) return p;
  return MEDIA_BASE ? `${MEDIA_BASE}/${p.replace(/^\/+/, '')}` : p;
}

/* ---- load ---------------------------------------------------------- */
async function load() {
  let data;
  if (window.WALLPAPERS) {
    data = window.WALLPAPERS;
  } else {
    const res = await fetch('wallpapers.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  }
  let i = 0;
  for (const [, m] of Object.entries(data)) {
    m._resTier = bucketRes(m.width, m.height);
    m._idx = i++;
    m._chip = pickDominant(m.colors, COLOR_DOTS[m.color]);
    m._ramp = rampGradient(m.colors);
    m._barColor = COLOR_DOTS[m.color] || '#6f7aa6';
  }
  STATE.entries = Object.entries(data);
  STATE.byPath = data;
  STATE.mask = new Uint8Array(STATE.entries.length);
  STATE.favs = loadFavs();

  setCount(STATE.entries.length, STATE.entries.length);

  readUrl();
  $('#q').value = STATE.filters.q || '';
  buildFilters();
  STATE.featured = pickFeatured();
  applyFilters({ writeUrl: false });
  initHeatmap();
  renderFeatured();

  const hashPath = decodeHashPath();
  if (hashPath && STATE.byPath[hashPath]) {
    openLightbox(hashPath, STATE.byPath[hashPath], { push: false });
  }
}

function setCount(filtered, total) {
  $('#count').textContent = `${filtered}/${total}`;
  const sc = $('#statusCount');
  if (sc) {
    sc.replaceChildren();
    const b = el('b', null, String(filtered));
    sc.append(b, document.createTextNode(` / ${total} wallpapers`));
  }
}

/* ---- facet counting ------------------------------------------------ */
function inc(m, k) { if (!k) return; m.set(k, (m.get(k) || 0) + 1); }

function buildFilters() {
  const tones = new Map(), colors = new Map(), resolutions = new Map();
  for (const [, m] of STATE.entries) {
    inc(tones, m.tone);
    inc(colors, m.color);
    inc(resolutions, m._resTier);
  }

  filtersEl.replaceChildren();
  const toneItems  = ['dark','light'].filter(t => tones.has(t));
  const colorItems = COLOR_ORDER.filter(c => colors.has(c));
  const resItems   = RES_TIERS.filter(t => resolutions.has(t));

  filtersEl.appendChild(buildFilterSection('tone', 't',
    () => filterListEl('tone', toneItems, TONE_DOTS)));
  filtersEl.appendChild(buildFilterSection('color', 'c',
    () => filterListEl('color', colorItems, COLOR_DOTS)));
  filtersEl.appendChild(buildFilterSection('resolution', 'r',
    () => rangeListEl('res_min', 'res_max', resItems)));
}

function buildFilterSection(label, hotkey, contentFn) {
  const sec = el('div', 'filter-section');
  const head = el('div', 'filter-section-label');
  head.appendChild(el('span', null, label));
  if (hotkey) head.appendChild(el('span', 'hk', hotkey));
  sec.appendChild(head);
  sec.appendChild(contentFn());
  return sec;
}

// Single-select clickable list. Each row uses the LIVE facet count so the
// numbers reflect what selecting that value would yield given other filters.
function filterListEl(filterKey, values, dotMap) {
  const list = el('div', 'flist');
  const live = STATE.facetCounts[filterKey] || {};
  for (const v of values) {
    const c = live[v] || 0;
    const item = el('div', 'flist-item');
    item.dataset.filter = filterKey;
    item.dataset.value = v;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-pressed', String(STATE.filters[filterKey] === v));
    if (STATE.filters[filterKey] === v) item.classList.add('selected');
    if (c === 0 && STATE.filters[filterKey] !== v) item.classList.add('zero');
    if (dotMap && dotMap[v]) {
      const dot = el('span', 'flist-dot');
      dot.style.color = dotMap[v];
      dot.style.background = dotMap[v];
      item.appendChild(dot);
    }
    item.appendChild(el('span', 'flist-name', v));
    item.appendChild(el('span', 'flist-count', String(c)));
    const act = () => toggleFilter(filterKey, v);
    item.addEventListener('click', act);
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
    list.appendChild(item);
  }
  return list;
}

// Resolution range list: each tier row has >= and <= toggle buttons so one
// list expresses both bounds. Clicking an active op clears that bound.
function rangeListEl(minKey, maxKey, items) {
  const list = el('div', 'flist');
  const liveMin = STATE.facetCounts[minKey] || {};
  const liveMax = STATE.facetCounts[maxKey] || {};
  for (const k of items) {
    const row = el('div', 'flist-range');
    row.appendChild(el('span', 'rname', k));
    const cMin = liveMin[k] || 0, cMax = liveMax[k] || 0;
    const count = Math.min(cMin || cMax, cMax || cMin);
    row.appendChild(el('span', 'rcount', String(count)));
    if (!count) row.classList.add('zero');

    const minBtn = el('button', 'op-btn');
    minBtn.type = 'button'; minBtn.textContent = '>=';
    minBtn.title = `at least ${k}`; minBtn.setAttribute('aria-label', `resolution at least ${k}`);
    if (STATE.filters[minKey] === k) minBtn.classList.add('active');
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      STATE.filters[minKey] = STATE.filters[minKey] === k ? null : k;
      applyFilters();
    });
    row.appendChild(minBtn);

    const maxBtn = el('button', 'op-btn');
    maxBtn.type = 'button'; maxBtn.textContent = '<=';
    maxBtn.title = `at most ${k}`; maxBtn.setAttribute('aria-label', `resolution at most ${k}`);
    if (STATE.filters[maxKey] === k) maxBtn.classList.add('active');
    maxBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      STATE.filters[maxKey] = STATE.filters[maxKey] === k ? null : k;
      applyFilters();
    });
    row.appendChild(maxBtn);

    list.appendChild(row);
  }
  return list;
}

function facetField(m, key) {
  if (key === 'res_min' || key === 'res_max') return m._resTier;
  return m[key];
}

// True if entry m passes the filter for `key` given value `v`. Handles the
// range semantics for res_min / res_max (open-ended bounds).
function passesFilterKey(m, key, v) {
  if (!v) return true;
  if (key === 'res_min' || key === 'res_max') {
    const entIdx = RES_TIERS.indexOf(m._resTier);
    const filtIdx = RES_TIERS.indexOf(v);
    if (entIdx < 0 || filtIdx < 0) return false;
    return key === 'res_min' ? entIdx >= filtIdx : entIdx <= filtIdx;
  }
  return facetField(m, key) === v;
}

function computeFacetCounts() {
  const f = STATE.filters;
  const q = f.q.trim().toLowerCase();
  const out = { tone: {}, color: {}, res_min: {}, res_max: {} };
  for (const [path, m] of STATE.entries) {
    if (q) {
      const hay = (path + ' ' + (m.title||'') + ' ' + (m.tags||[]).join(' ')).toLowerCase();
      if (!hay.includes(q)) continue;
    }
    for (const k of FILTER_KEYS) {
      // The count under k is "how many entries match if I set k to its
      // value(s)" - so all OTHER filters must pass.
      let match = true;
      for (const k2 of FILTER_KEYS) {
        if (k2 === k) continue;
        if (!passesFilterKey(m, k2, f[k2])) { match = false; break; }
      }
      if (!match) continue;
      const v = facetField(m, k);
      if (!v) continue;
      if (k === 'res_min') {
        const entIdx = RES_TIERS.indexOf(v);
        for (let i = 0; i <= entIdx; i++) out[k][RES_TIERS[i]] = (out[k][RES_TIERS[i]] || 0) + 1;
      } else if (k === 'res_max') {
        const entIdx = RES_TIERS.indexOf(v);
        for (let i = entIdx; i < RES_TIERS.length; i++) out[k][RES_TIERS[i]] = (out[k][RES_TIERS[i]] || 0) + 1;
      } else {
        out[k][v] = (out[k][v] || 0) + 1;
      }
    }
  }
  return out;
}

/* ---- filtering ----------------------------------------------------- */
function toggleFilter(key, val) {
  STATE.filters[key] = STATE.filters[key] === val ? null : val;
  applyFilters();
}

function hasActiveFilters() {
  return STATE.favOnly || FILTER_KEYS.some(k => STATE.filters[k]) || !!STATE.filters.q;
}

function applyFilters(opts = {}) {
  const f = STATE.filters;
  const q = f.q.trim().toLowerCase();
  const activeFilters = hasActiveFilters();
  STATE.mask.fill(0);
  STATE.filtered = STATE.entries.filter(([path, m]) => {
    if (STATE.favOnly && STATE.favs && !STATE.favs.has(path)) return false;
    for (const k of FILTER_KEYS) if (!passesFilterKey(m, k, f[k])) return false;
    if (q) {
      const hay = (path + ' ' + (m.title||'') + ' ' + (m.tags||[]).join(' ')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    STATE.mask[m._idx] = 1;
    return true;
  });
  setCount(STATE.filtered.length, STATE.entries.length);
  STATE.rendered = 0;
  STATE.firstPaint = true;
  grid.replaceChildren();
  renderViewState();
  STATE.facetCounts = computeFacetCounts();
  renderMore();
  buildFilters();           // refresh selected state + live counts
  renderCrumbs();
  updateFeaturedVisibility();
  updateFavControl();
  drawHeat();
  $('#reset').disabled = !activeFilters;
  if (opts.writeUrl !== false) writeUrl();
  lastFiltersSnap = filtersSnapshot();
}

function renderViewState() {
  const state = $('#viewState');
  if (!state) return;
  state.replaceChildren();
  state.hidden = true;
  document.body.classList.toggle('fav-view', STATE.favOnly);
  if (!STATE.favOnly) return;

  state.hidden = false;
  state.className = 'view-state favourites-state';
  const label = el('div', 'state-label', 'FAVOURITES');
  label.appendChild(document.createElement('span'));
  state.appendChild(label);

  const panel = el('div', 'state-panel');
  const head = el('div', 'state-panel-head');
  head.appendChild(el('span', 'state-star', '★'));
  head.appendChild(el('b', null, 'favourites'));
  head.appendChild(el('span', 'state-muted', '/ saved'));
  head.appendChild(el('span', 'state-count', `${STATE.favs ? STATE.favs.size : 0} / ${STATE.entries.length}`));
  panel.appendChild(head);
  state.appendChild(panel);
}

/* ---- status line breadcrumbs --------------------------------------- */
function renderCrumbs() {
  const wrap = $('#crumbs');
  wrap.replaceChildren();
  const parts = [];
  if (STATE.filters.q) parts.push({ k: 'search', v: '"' + STATE.filters.q + '"', clear: () => { STATE.filters.q = ''; $('#q').value = ''; } });
  if (STATE.filters.tone) parts.push({ k: 'tone', v: STATE.filters.tone, dot: TONE_DOTS[STATE.filters.tone], clear: () => STATE.filters.tone = null });
  if (STATE.filters.color) parts.push({ k: 'color', v: STATE.filters.color, dot: COLOR_DOTS[STATE.filters.color], clear: () => STATE.filters.color = null });
  if (STATE.filters.res_min || STATE.filters.res_max) {
    const mn = STATE.filters.res_min, mx = STATE.filters.res_max;
    const v = mn && mx ? `${mn}..${mx}` : mn ? `>=${mn}` : `<=${mx}`;
    parts.push({ k: 'res', v, clear: () => { STATE.filters.res_min = null; STATE.filters.res_max = null; } });
  }
  if (!parts.length) { wrap.appendChild(el('span', 'crumbs-empty', '~/omarchy/themes')); return; }
  for (const p of parts) {
    const c = el('span', 'crumb');
    c.tabIndex = 0; c.setAttribute('role', 'button');
    c.setAttribute('aria-label', `remove ${p.k} filter ${p.v}`);
    if (p.dot) { const d = el('span', 'crumb-dot'); d.style.background = p.dot; c.appendChild(d); }
    c.appendChild(el('span', 'crumb-k', p.k + ':'));
    c.appendChild(el('span', null, p.v));
    c.appendChild(el('span', 'x', '×'));
    const act = () => { p.clear(); applyFilters(); };
    c.addEventListener('click', act);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
    wrap.appendChild(c);
  }
}

/* ---- heatmap (canvas spectrum + scrubber) -------------------------- */
let heatCanvas, heatCtx, heatRAF = 0;
function initHeatmap() {
  heatCanvas = $('#heat');
  if (!heatCanvas) return;
  heatCtx = heatCanvas.getContext('2d');
  const wrap = $('#heatwrap');
  const cursor = $('#heatCursor');
  const tip = $('#heatTip');

  let scrubFrame = 0;
  function onMove(e) {
    const rect = heatCanvas.getBoundingClientRect();
    if (!rect.width) return;
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    if (scrubFrame) return;
    scrubFrame = requestAnimationFrame(() => {
      scrubFrame = 0;
      const n = STATE.entries.length;
      const idx = Math.max(0, Math.min(n - 1, Math.floor(x / rect.width * n)));
      const entry = STATE.entries[idx];
      if (!entry) return;
      const [path, m] = entry;
      cursor.style.transform = `translateX(${x}px)`;
      // Keep the tip inside the viewport horizontally.
      const tipX = Math.max(80, Math.min(rect.width - 80, x));
      tip.style.left = tipX + 'px';
      $('#heatTipTitle').textContent = m.title || path.split('/').pop();
      $('#heatTipMeta').textContent = `${m.dimensions || ''}  ${m.tone || ''}/${m.color || ''}`;
      $('#heatTipRamp').style.background = m._ramp;
      heatCanvas._hoverPath = path;
    });
  }
  heatCanvas.addEventListener('pointermove', onMove);
  heatCanvas.addEventListener('pointerenter', () => wrap.classList.add('scrub'));
  heatCanvas.addEventListener('pointerleave', () => { wrap.classList.remove('scrub'); heatCanvas._hoverPath = null; });
  heatCanvas.addEventListener('click', () => {
    const p = heatCanvas._hoverPath;
    if (p && STATE.byPath[p]) openLightbox(p, STATE.byPath[p]);
  });

  const ro = ('ResizeObserver' in window) ? new ResizeObserver(() => drawHeat()) : null;
  if (ro) ro.observe(wrap); else window.addEventListener('resize', debounce(drawHeat, 120));
  drawHeat();
}
function drawHeat() {
  if (!heatCtx || !heatCanvas) return;
  const rect = heatCanvas.getBoundingClientRect();
  const cssW = rect.width, cssH = rect.height;
  if (!cssW || !cssH) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  heatCanvas.width = Math.round(cssW * dpr);
  heatCanvas.height = Math.round(cssH * dpr);
  heatCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  heatCtx.clearRect(0, 0, cssW, cssH);

  const n = STATE.entries.length;
  if (!n) return;
  const bw = cssW / n;
  const anyFilter = hasActiveFilters();
  for (let i = 0; i < n; i++) {
    const m = STATE.entries[i][1];
    const on = !anyFilter || STATE.mask[i];
    heatCtx.globalAlpha = on ? 0.92 : 0.08;
    heatCtx.fillStyle = m._barColor;
    heatCtx.fillRect(i * bw, on ? 0 : cssH * 0.28, Math.max(1, bw + 0.7), on ? cssH : cssH * 0.44);
  }
  heatCtx.globalAlpha = 1;
}

/* ---- lazy images + infinite scroll --------------------------------- */
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && e.target.dataset.src) {
      const img = e.target;
      img.src = img.dataset.src;
      img.removeAttribute('data-src');
      io.unobserve(img);
    }
  }
}, { rootMargin: '400px' });

const sentinelIo = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting) renderMore();
}, { rootMargin: '700px' });

function renderMore() {
  if (STATE.rendered === 0 && STATE.filtered.length === 0) {
    const wrap = el('div', 'empty');
    const noFavs = STATE.favOnly && (!STATE.favs || STATE.favs.size === 0);
    const query = STATE.filters.q.trim();

    const icon = el('div', 'empty-icon', '∅');
    icon.setAttribute('aria-hidden', 'true');
    wrap.appendChild(icon);

    const copy = el('div');
    const big = el('div', 'empty-big');
    if (noFavs) {
      big.textContent = 'no favourites saved';
    } else if (query) {
      big.append(document.createTextNode('no wallpapers match '), el('span', null, '"' + query + '"'));
    } else {
      big.textContent = 'no wallpapers match your filters';
    }
    copy.appendChild(big);
    copy.appendChild(el('div', 'empty-sub', noFavs ? 'mark wallpapers with the star to collect them here' : `clear your filters to browse all ${STATE.entries.length} wallpapers`));
    wrap.appendChild(copy);

    const b = el('button', 'empty-btn');
    b.append(el('span', 'kbd', 'x'), document.createTextNode(noFavs ? 'browse all wallpapers' : 'reset filters'));
    b.addEventListener('click', () => $('#reset').click());
    wrap.appendChild(b);
    grid.appendChild(wrap);
    return;
  }
  const oldSentinel = grid.querySelector('.sentinel');
  if (oldSentinel) oldSentinel.remove();

  const reveal = STATE.firstPaint;
  STATE.firstPaint = false;
  const end = Math.min(STATE.filtered.length, STATE.rendered + STATE.pageSize);
  const frag = document.createDocumentFragment();
  for (let i = STATE.rendered; i < end; i++) {
    const card = cardEl(STATE.filtered[i]);
    if (reveal) {
      card.classList.add('reveal');
      // Cap the cascade so it is a wave, not a slog, across a full page.
      card.style.setProperty('--rd', Math.min(i, 16) * 22 + 'ms');
    }
    frag.appendChild(card);
  }
  STATE.rendered = end;

  if (end < STATE.filtered.length) {
    const sentinel = el('div', 'sentinel');
    frag.appendChild(sentinel);
    grid.appendChild(frag);
    sentinelIo.disconnect();
    sentinelIo.observe(sentinel);
  } else {
    grid.appendChild(frag);
  }
}

/* ---- favourites (localStorage) ------------------------------------- */
const FAV_KEY = 'omarchy-themes:favs';
function loadFavs() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveFavs() {
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...STATE.favs])); } catch {}
}
// A star button that toggles favourite state for `path`. The same path can
// appear in the grid and the featured row at once, so syncFavButtons keeps
// every copy in step.
function favButton(path) {
  const b = el('button', 'fav-btn');
  b.type = 'button';
  b.dataset.path = path;
  const on = STATE.favs && STATE.favs.has(path);
  if (on) b.classList.add('is-fav');
  b.setAttribute('aria-pressed', String(!!on));
  const lab = on ? 'Remove from favourites' : 'Add to favourites';
  b.title = lab; b.setAttribute('aria-label', lab);
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  // stopPropagation so the click does not also open the card's lightbox.
  b.addEventListener('click', (e) => { e.stopPropagation(); toggleFav(path); });
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
  return b;
}
function toggleFav(path) {
  if (!STATE.favs) STATE.favs = new Set();
  if (STATE.favs.has(path)) STATE.favs.delete(path);
  else STATE.favs.add(path);
  saveFavs();
  syncFavButtons(path);
  updateFavControl();
  // In the favourites-only view, un-favouriting should drop the card.
  if (STATE.favOnly) applyFilters();
}
function syncFavButtons(path) {
  const on = STATE.favs.has(path);
  for (const b of document.querySelectorAll('.fav-btn')) {
    if (b.dataset.path !== path) continue;
    b.classList.toggle('is-fav', on);
    b.setAttribute('aria-pressed', String(on));
    const lab = on ? 'Remove from favourites' : 'Add to favourites';
    b.title = lab; b.setAttribute('aria-label', lab);
    if (on) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  }
}
function updateFavControl() {
  const t = $('#favToggle');
  if (!t) return;
  const nEl = t.querySelector('.fav-n');
  if (nEl) nEl.textContent = String(STATE.favs ? STATE.favs.size : 0);
  t.classList.toggle('active', STATE.favOnly);
  t.setAttribute('aria-pressed', String(STATE.favOnly));
}

function cardEl([path, m], opts = {}) {
  const card = el('div', 'card');
  if (opts.featured) card.classList.add('featured-card');
  card.title = m.title || path;
  card.style.setProperty('--chip', m._chip);

  const imgWrap = el('div', 'card-image');
  const img = document.createElement('img');
  img.alt = m.title || path;
  img.loading = 'lazy'; img.decoding = 'async';
  const thumbUrl = mediaUrl(m.thumb_path);
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => imgWrap.classList.add('is-unavailable'));
  if (thumbUrl) {
    img.dataset.src = thumbUrl;
    io.observe(img);
  } else {
    imgWrap.classList.add('is-unavailable');
  }
  imgWrap.appendChild(img);
  const fallback = el('div', 'image-fallback', 'preview unavailable');
  fallback.setAttribute('role', 'status');
  imgWrap.appendChild(fallback);
  imgWrap.appendChild(favButton(path));

  const overlay = el('div', 'card-overlay');
  overlay.appendChild(el('span', 'card-title', m.title || path.split('/').pop()));
  const swatches = el('div', 'card-swatches');
  const colors = Array.isArray(m.colors) ? m.colors.slice(0, 5) : [];
  for (const c of colors) {
    const sw = el('span', 'card-swatch');
    sw.style.background = c;
    swatches.appendChild(sw);
  }
  overlay.appendChild(swatches);
  imgWrap.appendChild(overlay);
  card.appendChild(imgWrap);

  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.setAttribute('aria-label', (m.title || path.split('/').pop()) + ', open five theme variants');
  const open = () => openLightbox(path, m);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  // Keyboard-focus ring without stealing the mouse-click look.
  card.addEventListener('focus', () => { if (card.matches(':focus-visible')) card.classList.add('kbf'); });
  card.addEventListener('blur', () => card.classList.remove('kbf'));
  return card;
}

/* ---- featured: 3 random picks, one per color, re-rolled each visit -- */
// Group by color, shuffle the colors, take one random entry from each of the
// first n - so the picks are always a different color and a fresh set every
// page load (and every shuffle click).
function pickFeatured(n = 3) {
  const byColor = new Map();
  for (const e of STATE.entries) {
    const c = e[1].color;
    if (!c) continue;
    if (!byColor.has(c)) byColor.set(c, []);
    byColor.get(c).push(e);
  }
  const colors = [...byColor.keys()];
  for (let i = colors.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [colors[i], colors[j]] = [colors[j], colors[i]];
  }
  const picks = [];
  for (const c of colors) {
    if (picks.length >= n) break;
    const arr = byColor.get(c);
    picks.push(arr[Math.floor(Math.random() * arr.length)]);
  }
  return picks;
}

function shuffleIcon() {
  const w = document.createElement('span');
  w.style.display = 'inline-flex';
  w.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>';
  return w.firstElementChild;
}
function starIcon() {
  const w = document.createElement('span');
  w.style.display = 'inline-flex';
  w.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  return w.firstElementChild;
}

function renderFeatured() {
  const sec = $('#featured');
  if (!sec) return;
  sec.replaceChildren();
  if (!STATE.featured || !STATE.featured.length) { sec.hidden = true; return; }

  const head = el('div', 'featured-head');
  const title = el('div', 'featured-title');
  title.appendChild(starIcon());
  title.appendChild(el('span', null, 'Featured'));
  head.appendChild(title);
  head.appendChild(el('div', 'featured-sub', STATE.featured.length + ' picks, fresh each visit'));

  const shuffle = el('button', 'featured-shuffle');
  shuffle.type = 'button';
  shuffle.title = 'Pick a new set';
  shuffle.setAttribute('aria-label', 'Shuffle featured wallpapers');
  shuffle.appendChild(shuffleIcon());
  shuffle.appendChild(el('span', null, 'shuffle'));
  shuffle.addEventListener('click', () => { STATE.featured = pickFeatured(); renderFeatured(); });
  head.appendChild(shuffle);
  sec.appendChild(head);

  const g = el('div', 'featured-grid');
  STATE.featured.forEach((entry, i) => {
    const card = cardEl(entry, { featured: true });
    card.classList.add('reveal');
    card.style.setProperty('--rd', i * 60 + 'ms');
    g.appendChild(card);
  });
  sec.appendChild(g);
  updateFeaturedVisibility();
}

// Featured is a default-view shelf. Hide it whenever any filter or search is
// active so the result set stays clean.
function updateFeaturedVisibility() {
  const sec = $('#featured');
  if (!sec) return;
  sec.hidden = hasActiveFilters() || !(STATE.featured && STATE.featured.length);
}

/* ---- lightbox ------------------------------------------------------ */
const lb = $('#lb');
const lbSide = $('#lbside');

function openLightbox(path, m, opts = {}) {
  const wrap = lb.querySelector('.lb-image-wrap');
  wrap.classList.remove('is-unavailable');
  wrap.replaceChildren();
  const img = document.createElement('img');
  img.src = mediaUrl(m.medium_path || path);
  img.alt = m.title || path;
  img.addEventListener('error', () => wrap.classList.add('is-unavailable'));
  wrap.appendChild(img);
  const fallback = el('div', 'lb-image-fallback', 'Preview unavailable');
  fallback.setAttribute('role', 'status');
  wrap.appendChild(fallback);
  const swatches = el('div', 'lb-preview-swatches');
  const colors = Array.isArray(m.colors) ? m.colors.slice(0, 6) : [];
  for (const c of colors) {
    const sw = el('span');
    sw.style.background = c;
    swatches.appendChild(sw);
  }
  wrap.appendChild(swatches);

  const chromeTitle = $('#lbChromeTitle');
  if (chromeTitle) chromeTitle.textContent = (m.title || path.split('/').pop()).toLowerCase().replace(/\s+/g, '-');

  // Palette-reactive tint. --vibe is mixed INTO the dark base everywhere it
  // is used, so even a pale/low-sat dominant stays contrast-safe.
  lb.style.setProperty('--vibe', m._chip || 'var(--accent)');

  renderSide(path, m);
  if (!lb._opener) lb._opener = document.activeElement;
  lb.classList.add('open');
  // Ramp the frost up on the next frame so the transition actually plays.
  requestAnimationFrame(() => lb.classList.add('frost'));
  document.body.style.overflow = 'hidden';
  setMode('VIEW');
  requestAnimationFrame(() => { const c = $('#lbclose'); if (c) c.focus(); });

  if (opts.push !== false) {
    const newUrl = buildUrl({ withHash: false }) + '#' + encodePath(path);
    history.pushState({ lightbox: path }, '', newUrl);
  }
}

async function copyText(text, target) {
  let copied = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {}
  if (!copied) {
    const active = document.activeElement;
    const input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(input);
    input.select();
    try { copied = document.execCommand('copy'); } catch {}
    input.remove();
    if (active && active.focus) active.focus();
  }
  if (target) {
    const orig = target.textContent;
    target.textContent = copied ? 'copied' : 'copy failed';
    setTimeout(() => target.textContent = orig, 900);
  }
  return copied;
}

async function copyAndNotify(text, title, detail) {
  if (await copyText(text)) {
    showToast(title, detail, true);
    return true;
  }
  showToast('Copy failed', 'Clipboard access is unavailable');
  return false;
}

function variantPanel(path, m, scheme, theme) {
  const label = VARIANT_LABEL[scheme] || scheme;
  const slug = theme.name || '';

  const panel = el('div', 'variant');
  panel.style.setProperty('--vhue', HUE_BY_SCHEME[scheme] || 'var(--border)');

  const head = el('div', 'variant-head');
  const name = el('div', 'variant-name');
  name.appendChild(el('span', 'vdot'));
  name.appendChild(el('span', null, label));
  head.appendChild(name);

  // Two buttons: Edit opens the theme editor in Aether so the user can tweak
  // the palette and choose where to save it; Apply is the trusted one-click
  // install path (silent + as_omarchy_theme=<slug>). Same aether:// endpoint,
  // different flags. These params are a contract with the Aether app.
  if (theme.colors_toml) {
    const baseParams = new URLSearchParams();
    baseParams.set('colors', mediaUrl(theme.colors_toml));
    baseParams.set('wallpaper', mediaUrl(path));

    const actions = el('div', 'variant-actions');

    const editParams = new URLSearchParams(baseParams);
    editParams.set('edit', 'true');
    const edit = el('a', 'variant-edit');
    edit.href = `aether://apply?${editParams.toString()}`;
    edit.title = `Open ${label} in Aether's editor`;
    edit.appendChild(makeIcon('pencil'));
    edit.appendChild(document.createTextNode('Edit'));
    actions.appendChild(edit);

    const applyParams = new URLSearchParams(baseParams);
    applyParams.set('silent', 'true');
    applyParams.set('as_omarchy_theme', slug);
    const apply = el('a', 'variant-apply');
    apply.href = `aether://apply?${applyParams.toString()}`;
    apply.title = `Apply ${label} with Aether (installs as ${slug})`;
    setApplyContent(apply, 'Apply');
    actions.appendChild(apply);

    head.appendChild(actions);
  }
  panel.appendChild(head);

  // 16-color ANSI strip; click any swatch to copy its hex. Real spans here
  // (unlike the gradient on cards) because they are interactive.
  if (theme.colors) {
    const ramp = el('div', 'ramp');
    for (const k of ANSI_KEYS) {
      const hex = theme.colors[k] || '';
      const sl = el('div', 'sl');
      sl.style.background = hex || 'transparent';
      sl.title = `${k}: ${hex}`;
      sl.style.cursor = 'pointer';
      sl.setAttribute('role', 'button');
      sl.tabIndex = 0;
      sl.setAttribute('aria-label', `copy ${k} ${hex}`);
      const copySl = async (e) => {
        e.stopPropagation();
        if (!hex) return;
        if (await copyAndNotify(hex, 'Copied ' + hex, k)) {
          sl.classList.add('copied'); setTimeout(() => sl.classList.remove('copied'), 650);
        }
      };
      sl.addEventListener('click', copySl);
      sl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') copySl(e); });
      ramp.appendChild(sl);
    }
    panel.appendChild(ramp);
  }

  const foot = el('div', 'variant-foot');
  foot.appendChild(el('span', 'slug', slug));
  panel.appendChild(foot);
  return panel;
}

function renderSide(path, m) {
  lbSide.replaceChildren();

  const titleWrap = el('div', 'lb-title-wrap');
  const titleRow = el('div', 'lb-title-row');
  titleRow.appendChild(el('span', 'lb-title', m.title || path.split('/').pop()));
  if (m.tone) titleRow.appendChild(el('span', 'lb-tone', String(m.tone).toUpperCase()));
  titleWrap.appendChild(titleRow);
  const variantCount = Object.keys(m.themes || {}).length;
  titleWrap.appendChild(el('div', 'lb-meta', `${variantCount} variants · ${m.dimensions || 'wallpaper'} · ${m.color || 'palette'}`));
  lbSide.appendChild(titleWrap);

  const palette = Array.isArray(m.colors) ? m.colors.slice(0, 10) : [];
  if (palette.length) {
    lbSide.appendChild(el('div', 'lb-sec-label', 'PALETTE'));
    const pgrid = el('div', 'lb-palette');
    palette.forEach((hex, i) => {
      const row = el('button', 'lb-palette-row');
      row.type = 'button';
      row.title = 'Copy ' + hex;
      row.appendChild(el('span', 'lb-palette-swatch'));
      row.firstChild.style.background = hex;
      row.appendChild(el('span', 'lb-palette-name', 'swatch ' + String(i + 1).padStart(2, '0')));
      row.appendChild(el('span', 'lb-palette-hex', hex));
      row.addEventListener('click', () => { copyAndNotify(hex, 'Copied ' + hex, 'palette swatch'); });
      pgrid.appendChild(row);
    });
    lbSide.appendChild(pgrid);
  }

  if (m.tags && m.tags.length) {
    const wrap = el('div', 'tags');
    m.tags.forEach(t => wrap.appendChild(el('span', 'tag', t)));
    lbSide.appendChild(wrap);
  }

  // Variants in fixed order Deep > Warm > Cool > Material > Aether.
  if (m.themes) {
    lbSide.appendChild(el('div', 'lb-sec-label', 'ONE-CLICK APPLY'));
    const vlist = el('div', 'lb-variants');
    for (const scheme of VARIANT_ORDER) {
      const theme = m.themes[scheme];
      if (!theme) continue;
      vlist.appendChild(variantPanel(path, m, scheme, theme));
    }
    lbSide.appendChild(vlist);
  }

  const actions = el('div', 'lb-actions');
  const fav = el('button', 'lb-secondary-action', (STATE.favs && STATE.favs.has(path)) ? '★ saved  f' : '★ favourite  f');
  fav.type = 'button';
  fav.addEventListener('click', () => { toggleFav(path); fav.textContent = (STATE.favs && STATE.favs.has(path)) ? '★ saved  f' : '★ favourite  f'; });
  actions.appendChild(fav);
  const wallpaper = el('button', 'lb-secondary-action', '⤓ wallpaper  y');
  wallpaper.type = 'button';
  wallpaper.addEventListener('click', () => { copyAndNotify(mediaUrl(path), 'Copied wallpaper URL', path); });
  actions.appendChild(wallpaper);
  lbSide.appendChild(actions);

  lbSide.appendChild(el('div', 'lb-path', path));
}

function closeLightbox(opts = {}) {
  if (!lb.classList.contains('open')) return;
  lb.classList.remove('open');
  lb.classList.remove('frost');
  lb.querySelector('.lb-image-wrap').replaceChildren();
  document.body.style.overflow = '';
  setMode(document.activeElement === $('#q') ? 'SEARCH' : 'NORMAL');
  if (lb._opener && lb._opener.focus) lb._opener.focus();
  lb._opener = null;

  if (opts.pop !== false && history.state && history.state.lightbox) {
    history.back();
  } else if (opts.pop !== false && location.hash) {
    history.replaceState(null, '', buildUrl({ withHash: false }));
  }
}
$('#lbclose').addEventListener('click', () => closeLightbox());
lb.addEventListener('click', (e) => { if (e.target === lb || e.target.classList.contains('lb-image-wrap')) closeLightbox(); });

// Lightbox navigation across the filtered list, wrapping at the ends.
function navLightbox(delta) {
  if (!lb.classList.contains('open')) return;
  const hashPath = decodeHashPath();
  if (!hashPath) return;
  const list = STATE.filtered;
  if (!list.length) return;
  const idx = list.findIndex(([p]) => p === hashPath);
  if (idx < 0) return;
  const nextIdx = (idx + delta + list.length) % list.length;
  const [nextPath, nextEntry] = list[nextIdx];
  openLightbox(nextPath, nextEntry, { push: false });
  history.replaceState({ lightbox: nextPath }, '', buildUrl({ withHash: false }) + '#' + encodePath(nextPath));
}

function trapLightboxFocus(e) {
  if (e.key !== 'Tab') return false;
  const focusable = [...lb.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(node => node.getClientRects().length);
  if (!focusable.length) return true;
  const index = focusable.indexOf(document.activeElement);
  if (index < 0 || (!e.shiftKey && index === focusable.length - 1)) {
    e.preventDefault();
    focusable[0].focus();
  } else if (e.shiftKey && index === 0) {
    e.preventDefault();
    focusable[focusable.length - 1].focus();
  }
  return true;
}

/* ---- mode pill ----------------------------------------------------- */
function setMode(mode) { const el = $('#mode'); if (el) el.textContent = mode; }

/* ---- global keyboard ----------------------------------------------- */
function typingInField(e) {
  const t = e.target;
  return t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}
let lastG = 0;
document.addEventListener('keydown', (e) => {
  // When the lightbox is open it owns navigation.
  if (lb.classList.contains('open')) {
    if (typingInField(e)) { if (e.key === 'Escape') closeLightbox(); return; }
    if (e.key === 'Escape') return closeLightbox();
    if (trapLightboxFocus(e)) return;
    const hashPath = decodeHashPath();
    if (e.key === 'f' && hashPath) { e.preventDefault(); toggleFav(hashPath); renderSide(hashPath, STATE.byPath[hashPath]); return; }
    if (e.key === 'y' && hashPath) { e.preventDefault(); copyAndNotify(mediaUrl(hashPath), 'Copied wallpaper URL', hashPath); return; }
    const prev = e.key === 'ArrowLeft' || e.key === 'h';
    const next = e.key === 'ArrowRight' || e.key === 'l';
    if (prev) { e.preventDefault(); navLightbox(-1); }
    else if (next) { e.preventDefault(); navLightbox(+1); }
    return;
  }

  // The "/" focuses search from anywhere. Esc blurs/clears search focus.
  if (!typingInField(e) && (e.key === '/' )) { e.preventDefault(); $('#q').focus(); return; }

  // Hotkeys must NOT fire while typing in the search field (except Esc).
  if (typingInField(e)) {
    if (e.key === 'Escape') { e.target.blur(); setMode('NORMAL'); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case 'x': if (hasActiveFilters()) $('#reset').click(); break;
    case 'g': {
      const now = e.timeStamp || 0;
      if (now - lastG < 500) { window.scrollTo({ top: 0 }); lastG = 0; }
      else lastG = now;
      break;
    }
    case 'G': window.scrollTo({ top: document.body.scrollHeight }); break;
  }
});

/* ---- apply-button acknowledgement ---------------------------------- */
const TOAST = $('#toast'), TOAST_TITLE = $('#toast-title'), TOAST_DETAIL = $('#toast-detail'), TOAST_DOT = $('#toast-dot');
let toastTimer = null;
function showToast(title, detail, ok = false) {
  TOAST_TITLE.textContent = title;
  TOAST_DETAIL.textContent = detail || '';
  TOAST_DOT.classList.toggle('ok', ok);
  TOAST.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => TOAST.classList.remove('show'), 2800);
}

const ICON_SVG = {
  play:   '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20"/></svg>',
  pencil: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  check:  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
};
function makeIcon(name) {
  const wrap = document.createElement('span');
  wrap.style.display = 'inline-flex';
  wrap.innerHTML = ICON_SVG[name] || '';
  return wrap.firstElementChild;
}
function setApplyContent(btn, label, mode) {
  btn.replaceChildren();
  if (mode === 'spin') {
    const spin = document.createElement('span'); spin.className = 'spin'; btn.appendChild(spin);
  } else if (mode) {
    const ic = makeIcon(mode); if (ic) btn.appendChild(ic);
  }
  btn.appendChild(document.createTextNode(label));
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.variant-apply');
  if (!btn) return;
  // Do not block the browser from opening aether://. We can acknowledge this
  // click, but cannot observe whether Aether accepted the protocol request.
  const originalText = btn.dataset.originalText || (btn.textContent || 'Apply');
  btn.dataset.originalText = originalText;
  const panel = btn.closest('.variant');
  const nameEl = panel && panel.querySelector('.variant-name');
  const slugStr = nameEl ? nameEl.textContent.trim() : '';

  btn.classList.add('applying');
  setApplyContent(btn, 'Opening', 'spin');
  showToast('Opening Aether request', slugStr ? `${slugStr} - requires Aether` : 'requires Aether');
  setTimeout(() => {
    btn.classList.remove('applying');
    setApplyContent(btn, originalText);
  }, 1400);
});

/* ---- history / popstate -------------------------------------------- */
function filtersSnapshot() { return JSON.stringify({ f: STATE.filters, fav: STATE.favOnly }); }
let lastFiltersSnap = '';

window.addEventListener('popstate', () => {
  const prev = lastFiltersSnap;
  readUrl();
  const curr = filtersSnapshot();
  lastFiltersSnap = curr;
  if (curr !== prev) {
    $('#q').value = STATE.filters.q || '';
    applyFilters({ writeUrl: false });
  }
  const hashPath = decodeHashPath();
  const isOpen = lb.classList.contains('open');
  if (hashPath && STATE.byPath[hashPath]) {
    if (!isOpen) openLightbox(hashPath, STATE.byPath[hashPath], { push: false });
  } else if (isOpen) {
    closeLightbox({ pop: false });
  }
});

/* ---- search + reset ------------------------------------------------ */
$('#q').addEventListener('input', debounce((e) => {
  STATE.filters.q = e.target.value;
  applyFilters();
}, 130));
$('#q').addEventListener('focus', () => { if (!lb.classList.contains('open')) setMode('SEARCH'); });
$('#q').addEventListener('blur', () => { if (!lb.classList.contains('open')) setMode('NORMAL'); });

$('#reset').addEventListener('click', () => {
  STATE.filters = { tone: null, color: null, res_min: null, res_max: null, q: '' };
  STATE.favOnly = false;
  $('#q').value = '';
  applyFilters();
});

$('#favToggle').addEventListener('click', () => {
  STATE.favOnly = !STATE.favOnly;
  applyFilters();
});

/* ---- boot ---------------------------------------------------------- */
function showLoadError(err) {
  grid.replaceChildren();
  const wrap = el('div', 'empty');
  wrap.appendChild(el('div', 'empty-big', 'Could not load themes'));
  wrap.appendChild(el('div', 'empty-sub', 'Error: ' + (err && err.message || String(err))));
  grid.appendChild(wrap);
}
function hideLoader() { const l = $('#loading'); if (l) l.classList.add('hidden'); }

load().then(hideLoader).catch(err => { hideLoader(); showLoadError(err); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW register failed:', err));
  });
}
