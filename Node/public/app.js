/*
 * app.js -- the web display: session-table semantics and panel rendering.
 *
 * Two things are ported from the firmware, deliberately and exactly:
 *
 *   sessions.h  -- the session table (slot allocation, state aliases, the
 *                  8-slot cap, off releasing a slot, ready being invisible,
 *                  evicting an invisible slot when full, focus = most recent)
 *   display.h   -- the layout (icon size by visible count, the grid, the
 *                  2px edge margin, the focus ring, the single-session
 *                  caption) and the animation cadence per state.
 *
 * The point is that this page reads as the same device as the OLED: given the
 * same server events, both should paint the same icons in the same places.
 * Node/tools/check_icons.js pins the glyphs themselves to icons.h.
 *
 * Transport is SSE (/events), fed by web_client.js, which is the only thing
 * talking to the server. The page never connects upstream itself, so it can
 * be served from anywhere and still see one consistent view.
 */

(function () {
  'use strict';

  const PANEL_W = 128;
  const PANEL_H = 64;
  const MAX_SESSIONS = 8;

  const I = window.Icons;

  // --- state aliases -----------------------------------------------------
  // sessions.h::toState. Unknown names fall back to STATE_UNKNOWN, which is
  // drawn as a turning gear -- an unrecognised state still reads as "busy",
  // and adding a state server-side needs no page change to keep displaying.
  const ALIASES = [
    [['thinking', 'think', 'analysis'], I.STATE_THINKING],
    [['busy', 'command', 'executing'], I.STATE_BUSY],
    [['success', 'ok', 'done'], I.STATE_SUCCESS],
    [['error', 'failed', 'fail'], I.STATE_ERROR],
    [['alarm', 'blocked', 'critical'], I.STATE_ALARM],
    [['idle', 'standby', 'waiting'], I.STATE_IDLE],
    [['ready', 'sessionstart', 'connected'], I.STATE_READY]
  ];

  function toState(name) {
    for (const group of ALIASES) {
      for (const a of group[0]) if (a === name) return group[1];
    }
    return I.STATE_UNKNOWN;
  }

  // display.h::stateName -- for the single-session caption.
  const STATE_NAMES = {
    [I.STATE_THINKING]: 'thinking',
    [I.STATE_BUSY]: 'busy', [I.STATE_SUCCESS]: 'success',
    [I.STATE_ERROR]: 'error', [I.STATE_ALARM]: 'alarm',
    [I.STATE_IDLE]: 'idle', [I.STATE_READY]: 'ready',
    [I.STATE_UNKNOWN]: 'off'
  };

  const EDITOR_LABEL = { claude: 'claude', codebuddy: 'codebuddy' };

  // --- session table -----------------------------------------------------
  // A direct port of sessions.h's SessionTable, including its deliberate
  // omissions: no expiry, no staleness sweep. The page shows exactly what the
  // server says; a session that dies without sending "off" keeps its icon
  // until the page is reloaded or the server restarts.
  class SessionTable {
    constructor() {
      this.slots = new Array(MAX_SESSIONS);
      for (let i = 0; i < MAX_SESSIONS; i++) this.slots[i] = null;
    }

    // Apply one event. Returns the slot index, or -1 if the table was full.
    update(id, stateName, editor, seq, now) {
      if (!id) return -1;

      // "off" means the session ended: free the slot if we held one.
      if (stateName === 'off') {
        const slot = this.find(id);
        if (slot >= 0) this.release(slot);
        return slot;
      }

      // Existing session: refresh in place so its icon position never moves.
      const slot = this.find(id);
      if (slot >= 0) {
        const s = this.slots[slot];
        s.state = toState(stateName);
        s.editor = editor || '';
        s.seq = seq;
        s.lastSeen = now;
        return slot;
      }

      const free = this.alloc();
      if (free < 0) {
        // Table full. Rather than ignoring the newcomer, evict an invisible
        // STATE_READY slot if there is one: an invisible slot costs nothing to
        // lose, while dropping a visible session would erase an icon the user
        // is watching.
        const ready = this.findState(I.STATE_READY);
        if (ready < 0) return -1; // no invisible slot to spare, 9th ignored
        this.release(ready);
      }
      const at = free < 0 ? this.alloc() : free;
      this.slots[at] = {
        id, state: toState(stateName), editor: editor || '',
        seq, lastSeen: now, history: [{ state: stateName, ts: Date.now() }]
      };
      return at;
    }

    clear() {
      for (let i = 0; i < MAX_SESSIONS; i++) this.slots[i] = null;
    }

    // Number of *visible* sessions. STATE_READY holds a slot but is never
    // drawn; counting it would leave holes in the grid -- the layout is sized
    // by this number, and nextUsed() walks the same set.
    count() {
      let n = 0;
      for (const s of this.slots) if (s && s.state !== I.STATE_READY) n++;
      return n;
    }

    // Slot of the session we heard from most recently. That one gets the focus
    // ring and is the only icon that animates. STATE_READY is skipped: its
    // lastSeen is always the freshest (SessionStart is the first event of a
    // session), so it would otherwise steal the ring around an icon that does
    // not exist.
    focusSlot() {
      let best = -1;
      let bestSeen = 0;
      for (let i = 0; i < MAX_SESSIONS; i++) {
        const s = this.slots[i];
        if (!s || s.state === I.STATE_READY) continue;
        if (best < 0 || s.lastSeen > bestSeen) { best = i; bestSeen = s.lastSeen; }
      }
      return best;
    }

    find(id) {
      for (let i = 0; i < MAX_SESSIONS; i++) {
        if (this.slots[i] && this.slots[i].id === id) return i;
      }
      return -1;
    }

    alloc() {
      for (let i = 0; i < MAX_SESSIONS; i++) if (!this.slots[i]) return i;
      return -1;
    }

    findState(st) {
      for (let i = 0; i < MAX_SESSIONS; i++) {
        if (this.slots[i] && this.slots[i].state === st) return i;
      }
      return -1;
    }

    release(i) { this.slots[i] = null; }
  }

  // --- glyph atlas -------------------------------------------------------
  // Each frame is rasterised once into a packed ABGR buffer (panel pixel order
  // for ImageData), so the render loop is just memcpy-ish spans.
  const ON_COLOR = 0xFFE8E6DF;   // lit pixel: warm off-white, like an OLED
  const OFF_COLOR = 0xFF0A0B0D;  // unlit: near-black, not pure black

  // Editors whose states ship as imported bitmap art, keyed by editor name:
  // claude's set is the Claude Code creature (素材/claudecode/*.png) and
  // codebuddy's is 素材/codebuddy/*.jpg. Loaded at runtime below; until the
  // images arrive the procedural sets from icons.js are shown (claude's are
  // also what tools/check_icons.js keeps byte-compared with icons.h).
  const ART_SETS = {
    claude: { dir: 'img/claudecode/', ext: '.png' },   // 320px
    codebuddy: { dir: 'img/codebuddy/', ext: '.jpg' }  // 1024px
  };

  const ATLAS = {};
  for (const size of I.SIZES) {
    ATLAS[size] = {};
    // Every editor starts on its procedural set from icons.js; the art sets
    // swap theirs in below once the images have loaded.
    for (const ed of Object.keys(ART_SETS)) {
      const frames = I.buildEditorFrames(ed, size);
      ATLAS[size][ed] = frames.map(group =>
        group.map(canvas => rasterise(canvas, size, size)));
    }
  }
  const BADGES = {
    // No badges: both editors' bitmap art already identifies them, and the
    // badge square would sit exactly on the bottom-right of that art -- the
    // creature's feet and side marks, codebuddy's state marks.
  };

  // --- imported bitmap icon sets -----------------------------------------
  // The art editors' states ship as bitmap art (ART_SETS above): white glyph
  // on black. A luminance threshold maps it straight onto the panel's two
  // colours, so no palette is needed. The procedural sets above stay as the
  // fallback shown until the art has loaded (or if it fails) -- the panel must
  // never go blank waiting on an image.
  const ART_STATES = ['thinking', 'busy', 'success', 'error', 'alarm', 'idle'];

  // Two-step downscale (source -> 256 -> size): a single-step draw from a
  // 1024px source drops to ~2% of the pixels and aliases badly at 28px;
  // stepping down keeps the glyph edges readable.
  function rasteriseImage(image, size) {
    const mid = document.createElement('canvas');
    mid.width = 256; mid.height = 256;
    const mctx = mid.getContext('2d', { willReadFrequently: true });
    mctx.imageSmoothingEnabled = true;
    mctx.imageSmoothingQuality = 'high';
    mctx.drawImage(image, 0, 0, 256, 256);

    const out = document.createElement('canvas');
    out.width = size; out.height = size;
    const octx = out.getContext('2d', { willReadFrequently: true });
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(mid, 0, 0, size, size);

    const px = octx.getImageData(0, 0, size, size).data;
    const buf = new Uint32Array(size * size);
    for (let i = 0; i < buf.length; i++) {
      const lum = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] +
                  0.0722 * px[i * 4 + 2];
      buf[i] = lum >= 128 ? ON_COLOR : OFF_COLOR;
    }
    return buf;
  }

  function rebuildArtAtlas(editor, art) {
    for (const size of I.SIZES) {
      const set = new Array(8);
      for (let st = 0; st <= I.STATE_READY; st++) {
        // Unknown draws as thinking; ready holds a slot but is never drawn.
        const name = st === I.STATE_UNKNOWN ? 'thinking'
                   : st === I.STATE_READY ? null
                   : ART_STATES[st - 1];
        set[st] = name
          ? [rasteriseImage(art[name], size)]
          : [new Uint32Array(size * size).fill(OFF_COLOR)];
      }
      ATLAS[size][editor] = set;
    }
  }

  (function loadArtSets() {
    for (const editor of Object.keys(ART_SETS)) {
      const cfg = ART_SETS[editor];
      const art = {};
      let pending = ART_STATES.length;
      for (const name of ART_STATES) {
        const im = new Image();
        im.onload = () => {
          art[name] = im;
          if (--pending === 0) rebuildArtAtlas(editor, art);
        };
        im.onerror = () => {
          pending--;
          // Only rebuild if every image made it; otherwise keep the fallback.
          if (pending === 0 && Object.keys(art).length === ART_STATES.length)
            rebuildArtAtlas(editor, art);
        };
        im.src = cfg.dir + name + cfg.ext;
      }
    }
  })();

  function rasterise(canvas, w, h) {
    const out = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        out[y * w + x] = canvas[y][x] ? ON_COLOR : OFF_COLOR;
      }
    }
    return out;
  }

  // --- layout (display.h) ------------------------------------------------

  function iconSizeForCount(n) {
    if (n <= 2) return 48;
    if (n === 3) return 40;
    return 28;
  }

  function framePeriod(state) {
    const name = STATE_NAMES[state];
    return name ? (I.FRAME_MS[name] || 0) : 0;
  }

  // First used, *visible* slot at or after `from`. STATE_READY holds a slot
  // but is never drawn; including it here would put a hole in the grid.
  function nextUsed(table, from) {
    for (let i = from; i < MAX_SESSIONS; i++) {
      const s = table.slots[i];
      if (s && s.state !== I.STATE_READY) return i;
    }
    return MAX_SESSIONS;
  }

  // --- renderer ----------------------------------------------------------

  const canvas = document.getElementById('panel');
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(PANEL_W, PANEL_H);
  const view = new Uint32Array(img.data.buffer);

  const table = new SessionTable();
  let connected = false;
  let selectedId = null;

  // Test hook: freeze every animation at frame 0 so the panel can be compared
  // pixel-for-pixel with preview.py, which renders static frame 0. Harmless
  // in normal use -- it is only set by an explicit URL hash.
  const FREEZE_FRAMES = location.hash.includes('freeze');

  function clearPanel() { view.fill(OFF_COLOR); }

  function blit(buf, sw, dx, dy, w, h) {
    for (let y = 0; y < h; y++) {
      const sy = dy + y;
      if (sy < 0 || sy >= PANEL_H) continue;
      const drow = sy * PANEL_W;
      const srow = y * sw;
      for (let x = 0; x < w; x++) {
        const sx = dx + x;
        if (sx < 0 || sx >= PANEL_W) continue;
        view[drow + sx] = buf[srow + x];
      }
    }
  }

  // u8g2.drawFrame: a 1px outline. The firmware relies on it being clipped at
  // the panel edge, so the blit above clips instead of drawing a partial ring
  // of a different shape.
  function drawFrame(x, y, w, h) {
    for (let xx = x; xx < x + w; xx++) {
      setPixel(xx, y); setPixel(xx, y + h - 1);
    }
    for (let yy = y; yy < y + h; yy++) {
      setPixel(x, yy); setPixel(x + w - 1, yy);
    }
  }

  function setPixel(x, y) {
    if (x < 0 || y < 0 || x >= PANEL_W || y >= PANEL_H) return;
    view[y * PANEL_W + x] = ON_COLOR;
  }

  // display.h::drawSessionIcon
  function drawSessionIcon(slot, x, y, size, focus, now) {
    const s = table.slots[slot];
    // STATE_READY is a reserved-but-invisible slot ("session exists, has not
    // started working yet"). Draw nothing, not even the badge.
    if (s.state === I.STATE_READY) return;

    const set = ATLAS[size][s.editor] || ATLAS[size].claude;
    const icons = set[s.state];
    let frame = 0;
    if (slot === focus && icons.length > 1 && !FREEZE_FRAMES) {
      const period = framePeriod(s.state);
      if (period > 0) frame = Math.trunc(now / period) % icons.length;
    }

    blit(icons[frame], size, x, y, size, size);

    // Editor badge, bottom-right inside the icon, inset 2px so it sits in the
    // corner rather than touching the edge. Same bitmap at every icon size.
    const badge = BADGES[s.editor];
    if (badge && size >= I.BADGE_W + 4) {
      blit(badge, I.BADGE_W, x + size - I.BADGE_W - 2, y + size - I.BADGE_H - 2,
           I.BADGE_W, I.BADGE_H);
    }

    // Focus ring: 1px outline around the most recently active session.
    if (slot === focus) drawFrame(x - 2, y - 2, size + 4, size + 4);
  }

  // display.h::drawScene
  function drawScene(now) {
    const n = table.count();
    if (n === 0) return; // no sessions: keep the panel blank

    const focus = table.focusSlot();
    const size = iconSizeForCount(n);

    if (n === 1) {
      // One *visible* session: big icon, state name beneath it. No focus ring
      // -- with only one icon there is nothing to distinguish it from. The
      // caption is drawn in render(), after the pixel scene is on the canvas.
      const slot = nextUsed(table, 0);
      drawSessionIcon(slot, Math.trunc((PANEL_W - size) / 2), 4, size, focus, now);
      return;
    }

    const cols = n === 2 ? 2 : (n === 3 ? 3 : 4);
    const rows = n <= 3 ? 1 : 2;
    const cellW = Math.trunc(PANEL_W / cols);
    const cellH = Math.trunc(PANEL_H / rows);

    // Walk visible slots in table order; the grid is filled densely so any
    // gap (a slot released out of order, or an invisible STATE_READY slot)
    // closes up instead of leaving a hole.
    let slot = nextUsed(table, 0);
    for (let r = 0; r < rows && slot < MAX_SESSIONS; r++) {
      for (let c = 0; c < cols && slot < MAX_SESSIONS; c++) {
        // Keep 2px clear at the edges so the focus frame is never clipped.
        const x = Math.max(2, c * cellW + Math.trunc((cellW - size) / 2));
        const y = Math.max(2, r * cellH + Math.trunc((cellH - size) / 2));
        drawSessionIcon(slot, x, y, size, focus, now);
        slot = nextUsed(table, slot + 1);
      }
    }
  }

  // The caption is the only anti-aliased thing on the panel: draw the pixel
  // scene, put it on the canvas, then draw text on top.
  function render(now) {
    clearPanel();
    drawScene(now);
    ctx.putImageData(img, 0, 0);
    const n = table.count();
    if (n === 1) {
      const slot = nextUsed(table, 0);
      const s = table.slots[slot];
      if (s && s.state !== I.STATE_UNKNOWN) {
        const name = STATE_NAMES[s.state];
        const ed = EDITOR_LABEL[s.editor] || '';
        // The firmware centres it assuming 6px per glyph (u8g2_font_6x13_tr).
        // The page has real fonts, so measure instead of assuming: the caption
        // ends up centred for real rather than centred by an approximation.
        ctx.font = '10px "DejaVu Sans Mono", monospace';
        ctx.textBaseline = 'alphabetic';
        const text = ed ? `${ed} · ${name}` : name;
        const w = ctx.measureText(text).width;
        ctx.fillStyle = '#e8e6df';
        ctx.fillText(text, Math.max(0, (PANEL_W - w) / 2), 61);
      }
    }
  }

  function loop() {
    render(performance.now());
    requestAnimationFrame(loop);
  }

  // --- events ------------------------------------------------------------
  // The server sends two shapes (Server.pm / ws.h::parseMessage):
  //   {"type":"state", "state":"busy","session_id":"..","editor":"claude",..}
  //   {"type":"snapshot","sessions":[{"session_id":"..","state":"busy",..}]}

  function applyMessage(msg, raw) {
    pushMessage(raw); // raw feed first, so it shows even if parsing fails

    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'snapshot' && Array.isArray(msg.sessions)) {
      // Rebuild the whole table: the snapshot is authoritative.
      table.clear();
      const now = performance.now();
      for (const row of msg.sessions) {
        if (!row || typeof row !== 'object') continue;
        table.update(row.session_id, row.state, row.editor, 0, now);
      }
      updateDetails();
      return;
    }

    if (msg.type !== undefined && msg.type !== 'state') return;

    if (typeof msg.state !== 'string') return;
    const id = typeof msg.session_id === 'string' ? msg.session_id : '';
    const now = performance.now();
    const slot = table.update(id, msg.state, msg.editor, msg.seq || 0, now);

    if (slot >= 0) {
      const s = table.slots[slot];
      if (s) {
        const last = s.history[s.history.length - 1];
        if (!last || last.state !== msg.state) {
          // A real transition into a terminal state gets its sound cue.
          // A session born straight into success/error has no `last` and
          // stays silent, and repeats of the same state are deduped here.
          if (last) playSound(toState(msg.state));
          s.history.push({ state: msg.state, ts: msg.ts || Date.now() });
        }
      }
    }
    updateDetails();
  }

  // --- sounds ------------------------------------------------------------
  // One audio cue per terminal state: a chime when a session lands in
  // success, a buzz when it lands in error. Only live transitions reach
  // playSound() -- the snapshot path returns above, so loading or
  // reconnecting the page never replays cues for sessions already parked
  // in a terminal state. Sounds are Mixkit sfx (free licence):
  //   success.mp3 "Correct answer tone", error.mp3 "Wrong answer fail
  //   notification" -- swap the files or extend SOUNDS (e.g. alarm) at will.
  const SOUNDS = {
    [I.STATE_SUCCESS]: 'snd/success.mp3',
    [I.STATE_ERROR]: 'snd/error.mp3'
  };

  // localStorage can throw in private mode / odd embeds; the preference is
  // cosmetic, so degrade to "on" rather than break the page.
  let soundOn = loadSoundPref();
  const soundToggle = document.getElementById('snd-toggle');

  function loadSoundPref() {
    try { return localStorage.getItem('snd') !== 'off'; } catch (e) { return true; }
  }

  function saveSoundPref(on) {
    try { localStorage.setItem('snd', on ? 'on' : 'off'); } catch (e) { /* ignore */ }
  }

  function updateSoundToggle() {
    soundToggle.textContent = soundOn ? '🔔' : '🔕';
    soundToggle.title = soundOn ? '提示音已开（点击静音）'
                                : '提示音已关（点击开启）';
  }

  // Preload so the first trigger plays instantly instead of fetching then.
  for (const src of Object.values(SOUNDS)) new Audio(src).load();

  function playSound(state) {
    const src = SOUNDS[state];
    if (!src || !soundOn) return;
    // A fresh Audio per trigger so simultaneous sessions are heard together.
    // play() rejects until the browser has seen a user gesture (autoplay
    // policy) -- clicking the bell or anything else on the page unlocks it.
    const a = new Audio(src);
    a.volume = 0.8;
    a.play().catch(() => {});
  }

  soundToggle.addEventListener('click', () => {
    soundOn = !soundOn;
    saveSoundPref(soundOn);
    updateSoundToggle();
    // Turning it back on plays the chime once: confirmation of what it
    // sounds like, and proof the click also unlocked audio playback.
    if (soundOn) playSound(I.STATE_SUCCESS);
  });
  updateSoundToggle();

  // --- message feed ------------------------------------------------------

  const feed = document.getElementById('feed');
  const MAX_FEED = 200;

  function pushMessage(raw) {
    const el = document.createElement('div');
    el.className = 'msg';
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = clock(new Date());
    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = raw;
    el.appendChild(ts);
    el.appendChild(body);
    feed.prepend(el);
    while (feed.children.length > MAX_FEED) feed.lastChild.remove();
  }

  function clock(d) {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // --- session details ---------------------------------------------------

  const details = document.getElementById('details');

  function updateDetails() {
    const items = [];
    for (const s of table.slots) {
      if (s) items.push(s);
    }
    if (selectedId && !table.slots.some(s => s && s.id === selectedId)) {
      selectedId = null;
    }

    if (items.length === 0) {
      details.innerHTML =
        '<div class="hint">暂无会话。会话表为空时面板保持黑屏（与固件一致）。</div>';
      return;
    }

    // Most recently heard-from first, and drop the history rows for everyone
    // except the selected one -- the feed already shows every event.
    items.sort((a, b) => b.lastSeen - a.lastSeen);
    const html = items.map(s => {
      const name = STATE_NAMES[s.state];
      const selected = s.id === selectedId ? ' selected' : '';
      const editor = EDITOR_LABEL[s.editor] || 'unknown';
      const hist = s.id === selectedId
        ? `<div class="hist">${s.history.map(h =>
            `<div><span class="ts">${clock(new Date(h.ts))}</span>` +
            `<span class="st">${h.state}</span></div>`).join('')}</div>`
        : '';
      return `<div class="sess${selected}" data-id="${esc(s.id)}">` +
        `<div class="row"><span class="dot state-${name}"></span>` +
        `<span class="sid">${esc(shortId(s.id))}</span>` +
        `<span class="ed">${esc(editor)}</span>` +
        `<span class="st">${esc(name)}</span></div>${hist}</div>`;
    });
    details.innerHTML = html.join('');
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function shortId(id) {
    return id.length > 13 ? id.slice(0, 8) + '…' + id.slice(-4) : id;
  }

  details.addEventListener('click', e => {
    const el = e.target.closest('.sess');
    if (!el) return;
    selectedId = selectedId === el.dataset.id ? null : el.dataset.id;
    updateDetails();
  });

  // Clicking an icon selects that session too. The grid is dense, so the hit
  // test reuses the same layout walk the renderer used.
  canvas.addEventListener('click', e => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * PANEL_W / rect.width;
    const y = (e.clientY - rect.top) * PANEL_H / rect.height;
    const n = table.count();
    if (n === 0) return;
    const size = iconSizeForCount(n);
    const hit = iconAt(x, y, n, size);
    if (hit >= 0) {
      const s = table.slots[hit];
      if (s) { selectedId = selectedId === s.id ? null : s.id; updateDetails(); }
    }
  });

  function iconAt(px, py, n, size) {
    if (n === 1) {
      const slot = nextUsed(table, 0);
      const x = Math.trunc((PANEL_W - size) / 2);
      return inBox(px, py, x, 4, size) ? slot : -1;
    }
    const cols = n === 2 ? 2 : (n === 3 ? 3 : 4);
    const rows = n <= 3 ? 1 : 2;
    const cellW = Math.trunc(PANEL_W / cols);
    const cellH = Math.trunc(PANEL_H / rows);
    let slot = nextUsed(table, 0);
    for (let r = 0; r < rows && slot < MAX_SESSIONS; r++) {
      for (let c = 0; c < cols && slot < MAX_SESSIONS; c++) {
        const x = Math.max(2, c * cellW + Math.trunc((cellW - size) / 2));
        const y = Math.max(2, r * cellH + Math.trunc((cellH - size) / 2));
        if (inBox(px, py, x, y, size)) return slot;
        slot = nextUsed(table, slot + 1);
      }
    }
    return -1;
  }

  function inBox(px, py, x, y, size) {
    return px >= x && px < x + size && py >= y && py < y + size;
  }

  // --- transport ---------------------------------------------------------

  const statusEl = document.getElementById('conn-status');
  const statusText = document.getElementById('conn-text');
  let es = null;

  function setStatus(ok, text) {
    connected = ok;
    statusEl.className = 'dot ' + (ok ? 'conn-on' : 'conn-off');
    statusText.textContent = text;
  }

  function connect() {
    // EventSource reconnects on its own after a drop; this is for the initial
    // open and for giving up on a page that will never serve /events.
    es = new EventSource('/events');
    es.onopen = () => setStatus(true, '已连接');
    es.onerror = () => setStatus(false, '断开，重连中…');
    es.addEventListener('message', ev => {
      // Each frame is the server's own JSON, untouched.
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { /* feed shows the raw */ }
      applyMessage(msg, ev.data);
    });
  }

  // --- boot --------------------------------------------------------------

  updateDetails();
  connect();
  requestAnimationFrame(loop);
})();
