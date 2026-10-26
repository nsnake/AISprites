/*
 * icons.js -- monochrome session-state glyphs, ported from the retired
 *             procedural section of
 *             ESP32/esp32s3_ai_status_display/tools/gen_icons.py.
 *
 * Both editors' primary icons are imported bitmap art now: app.js loads
 * 素材/claudecode/*.png (claude) and 素材/codebuddy/*.jpg (codebuddy) at
 * runtime, and gen_icons.py imports the same files into icons.h. The
 * procedural glyphs in this file are the *fallback* the page shows until
 * that art has loaded (or if it fails) -- the panel must never go blank
 * waiting on an image. gen_icons.py no longer emits them into icons.h; it
 * keeps the drawing code as the reference implementation this port follows
 * one function for one, so the fallback is the same pixels it always was.
 * tools/check_icons.js checks icons.h's structure (both sets are imported
 * art there); it no longer byte-compares this port against icons.h.
 *
 * The shapes are drawn as size x size grids of 0/1 and only ever exist in
 * memory -- the XBM byte packing lives in bitmapBytes(), kept for callers
 * that need it. In the browser, buildIcons(size) returns per-state frame
 * lists that the page rasterises straight onto a canvas.
 *
 * Both worlds: works as a <script> (defines window.Icons) and as a Node
 * module (require('./icons.js')), so tooling gets the same code the page
 * runs.
 */

(function (global, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.Icons = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Icon sizes the firmware ships, and the size chosen for a given visible
  // session count (display.h::iconSizeForCount).
  const SIZES = [48, 40, 28];

  // Editor badges are drawn at one size for every icon scale.
  const BADGE_W = 12;
  const BADGE_H = 12;

  // SessionState order in sessions.h. ICONS_<size> tables are indexed by these
  // values, so the order here has to match the enum exactly.
  const STATE_UNKNOWN = 0;
  const STATE_THINKING = 1;
  const STATE_BUSY = 2;
  const STATE_SUCCESS = 3;
  const STATE_ERROR = 4;
  const STATE_ALARM = 5;
  const STATE_IDLE = 6;
  const STATE_READY = 7;

  // The glyphed states, in enum order minus the two that take no glyph
  // (unknown is drawn as thinking, ready is never drawn at all).
  const DRAWN_STATES = [
    'thinking', 'busy', 'success', 'error', 'alarm', 'idle'
  ];

  // Animation cadence per state, in ms. 0 means static. Mirrors
  // display.h::framePeriodMs, carried over from the retired LED build.
  const FRAME_MS = {
    thinking: 130, busy: 600, error: 140, alarm: 180, idle: 1600,
    success: 0, unknown: 0, ready: 0
  };

  // --- Python arithmetic shims -------------------------------------------
  // gen_icons.py is Python 3, and its pixel output is only reproducible if the
  // port matches Python's number semantics rather than JavaScript's:
  //   int()  truncates toward zero,
  //   round() breaks exact ties toward the even neighbour,
  //   %      always takes the sign of the divisor (JS takes the dividend's).
  function trunc(x) { return Math.trunc(x); }

  function pyRound(x) {
    const f = Math.floor(x);
    const d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1; // exact .5 -> nearest even
  }

  function pymod(a, m) { return ((a % m) + m) % m; }

  // --- canvas primitives --------------------------------------------------
  // Every glyph is built with just these five. A canvas is an array of rows,
  // each row an array of 0/1.

  function newCanvas(size) {
    const c = new Array(size);
    for (let y = 0; y < size; y++) c[y] = new Array(size).fill(0);
    return c;
  }

  function rect(c, size, x0, y0, x1, y1, on) {
    if (on === undefined) on = 1;
    for (let y = Math.max(0, y0); y <= Math.min(size - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(size - 1, x1); x++) {
        c[y][x] = on;
      }
    }
  }

  function disc(c, size, cx, cy, r, on) {
    if (on === undefined) on = 1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) c[y][x] = on;
      }
    }
  }

  function ring(c, size, cx, cy, r, thickness, on) {
    if (thickness === undefined) thickness = 1;
    if (on === undefined) on = 1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        if ((r - thickness) ** 2 < d2 && d2 <= r * r) c[y][x] = on;
      }
    }
  }

  // Bresenham with a square brush, exactly as gen_icons.py::line walks it.
  function line(c, size, x0, y0, x1, y1, on, width) {
    if (on === undefined) on = 1;
    if (!width) width = 1;
    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      rect(c, size, x0 - width + 1, y0 - width + 1,
           x0 + width - 1, y0 + width - 1, on);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  // Scanline fill of a closed polygon. Non-convex outlines (the gear's teeth)
  // cross a scanline more than twice; the k/k+1 pairing is the usual even-odd
  // walk that fills each span between successive crossings.
  function drawPoly(c, size, pts, on) {
    if (on === undefined) on = 1;
    const n = pts.length;
    for (let y = 0; y < size; y++) {
      const xs = [];
      for (let i = 0; i < n; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % n];
        if (p0[1] === p1[1]) continue; // horizontal edge: no crossing
        if (Math.min(p0[1], p1[1]) <= y && y < Math.max(p0[1], p1[1])) {
          xs.push(p0[0] + (y - p0[1]) * (p1[0] - p0[0]) / (p1[1] - p0[1]));
        }
      }
      xs.sort((a, b) => a - b); // JS sort() is lexical by default
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const lo = Math.max(0, Math.ceil(xs[k] - 0.5));
        const hi = Math.min(size - 1, Math.floor(xs[k + 1] + 0.5));
        for (let x = lo; x <= hi; x++) c[y][x] = on;
      }
    }
  }

  // --- state glyphs ------------------------------------------------------

  // A cog: N rectangular teeth around a ring with a hub. Each tooth is a
  // trapezoid sampled at the root and tip radii; the per-frame tooth_offset
  // advances the whole tooth phase, which reads as rotation.
  function gear(size, toothOffset) {
    const c = newCanvas(size);
    const cx = size / 2 - 0.5;
    const cy = size / 2 - 0.5;
    const teeth = size >= 40 ? 8 : 6;
    const rTip = size * 0.47;
    const rRoot = size * 0.35;
    const rRingInner = size * 0.22;
    const rHub = size * 0.10;
    const toothHalf = 0.32;  // fraction of a pitch a tooth occupies at the tip
    const rootHalf = 0.50;   // tooth is widest at the root (fills the rim)

    // Outer tooth silhouette: tip arc and root arc, sampled densely.
    const steps = 720;
    const outer = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const frac = t * teeth;
      let slot = frac - Math.floor(frac) - toothOffset;
      slot = pymod(slot + 0.5, 1.0) - 0.5;
      const r = Math.abs(slot) <= toothHalf ? rTip : rRoot;
      const ang = t * 2 * Math.PI;
      outer.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
    }
    drawPoly(c, size, outer);

    const innerHole = [];
    for (let i = 0; i <= steps; i++) {
      const ang = (i / steps) * 2 * Math.PI;
      innerHole.push([cx + rRingInner * Math.cos(ang),
                      cy + rRingInner * Math.sin(ang)]);
    }
    drawPoly(c, size, innerHole, 0);

    disc(c, size, cx + 0.5, cy + 0.5, rHub, 1);
    return c;
  }

  // Hourglass; phase flips the sand between the bulbs.
  function hourglass(size, phase) {
    const c = newCanvas(size);
    const m = size / 2;
    const top = trunc(size * 0.10);
    const bot = size - 1 - top;
    const half = size * 0.40;
    const w = Math.max(1, trunc(size / 16));
    // Frame: two filled triangles meeting at the centre, plus top/bottom rims.
    for (let y = top; y <= bot; y++) {
      const spread = (y - top) / (bot - top);
      const halfW = pyRound(half * (1.0 - Math.abs(2.0 * spread - 1.0)));
      for (let dx = -halfW - w + 1; dx < halfW + w; dx++) {
        const xx = trunc(pyRound(m + dx));
        if (xx >= 0 && xx < size && Math.abs(dx) > Math.max(0, halfW - 1)) {
          c[y][xx] = 1;
        }
      }
    }
    line(c, size, trunc(m - half), top, trunc(m + half), top, 1, w);
    line(c, size, trunc(m - half), bot, trunc(m + half), bot, 1, w);
    // Sand: upper bulb on phase 0, lower bulb on phase 1.
    const sw = Math.max(1, trunc(size * 0.11));
    if (phase === 0) {
      rect(c, size, trunc(m - sw), top + w, trunc(m + sw), trunc(m) - 1 - w);
    } else {
      rect(c, size, trunc(m - sw), trunc(m) + 1 + w, trunc(m + sw), bot - w);
    }
    line(c, size, trunc(m), trunc(m) - 2, trunc(m), trunc(m) + 2); // falling grains
    return c;
  }

  function check(size) {
    const c = newCanvas(size);
    const m = size / 2;
    const w = Math.max(1, trunc(size / 16));
    line(c, size, trunc(size * 0.20), trunc(m - size * 0.02),
         trunc(size * 0.42), trunc(size * 0.72), 1, w);
    line(c, size, trunc(size * 0.40), trunc(size * 0.72),
         trunc(size * 0.80), trunc(size * 0.26), 1, w);
    return c;
  }

  function cross(size) {
    const c = newCanvas(size);
    const w = Math.max(1, trunc(size / 9));
    line(c, size, trunc(size * 0.24), trunc(size * 0.24),
         trunc(size * 0.76), trunc(size * 0.76), 1, w);
    line(c, size, trunc(size * 0.76), trunc(size * 0.24),
         trunc(size * 0.24), trunc(size * 0.76), 1, w);
    return c;
  }

  function warning(size) {
    const c = newCanvas(size);
    const cx = size / 2;
    const top = size * 0.08;
    const bot = size * 0.92;
    const halfBase = size * 0.46;
    const w = Math.max(1, trunc(size / 14));
    line(c, size, trunc(cx - halfBase), trunc(bot),
         trunc(cx + halfBase), trunc(bot), 1, w);
    line(c, size, trunc(cx - halfBase), trunc(bot), trunc(cx), trunc(top), 1, w);
    line(c, size, trunc(cx + halfBase), trunc(bot), trunc(cx), trunc(top), 1, w);
    // Exclamation bar + dot, wide to read at 28px.
    const bw = Math.max(1, trunc(size / 11));
    rect(c, size, trunc(cx - bw / 2), trunc(size * 0.30),
         trunc(cx + bw / 2), trunc(size * 0.52));
    rect(c, size, trunc(cx - bw), trunc(size * 0.62),
         trunc(cx + bw), trunc(size * 0.70));
    return c;
  }

  // A small dot pulsing between two radii -- the idle "standby" mark.
  // Four frames: dim -> bright -> dim -> empty. The empty frame is what makes
  // it read as breathing rather than a blinking dot, and the long period keeps
  // it calm: this is "alive, waiting", not activity.
  function breath(size, phase) {
    const c = newCanvas(size);
    const cx = (size - 1) / 2;
    const cy = (size - 1) / 2;
    const rSmall = size * 0.14;
    const rBig = size * 0.26;
    const r = [rSmall, rBig, rSmall, 0.0][phase % 4];
    if (r > 0) disc(c, size, cx, cy, r);
    return c;
  }

  // --- editor badges -----------------------------------------------------
  // Retired on both ends: each editor's imported art identifies it by itself,
  // and the 12x12 square sat on the art's bottom-right (the creature's feet,
  // CodeBuddy's state marks). Neither icons.h nor app.js carries badges any
  // more; the shapes below stay as retired reference code alongside the rest
  // of the procedural set.

  // Sunburst: a small core with eight rays. Rays are wedges -- a pixel is lit
  // when it sits within an angular distance of a ray axis -- rather than
  // thick lines: a wide square brush on a diagonal fills the centre instead
  // of leaving gaps.
  function badgeClaude(size) {
    const c = newCanvas(size);
    const m = (size - 1) / 2;
    const rays = 8;
    const halfWidth = 0.17;
    const rIn = size * 0.08;
    const rOut = size * 0.475;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - m;
        const dy = y - m;
        const r = Math.hypot(dx, dy);
        if (r < rIn || r > rOut) continue;
        const ang = Math.atan2(dy, dx);
        let dev = Infinity;
        for (let i = 0; i < rays; i++) {
          const d = Math.abs(
            pymod(ang - (i * 2 * Math.PI) / rays + Math.PI, 2 * Math.PI)
            - Math.PI);
          if (d < dev) dev = d;
        }
        if (dev < halfWidth) c[y][x] = 1;
      }
    }
    disc(c, size, m, m, size * 0.14);
    return c;
  }

  // A speech bubble: CodeBuddy is a chat-oriented assistant. Filled rather
  // than outlined -- a 1px outline at 12px is a hollow box, and the tail has
  // to be a solid block to read as attached to the bubble.
  function badgeCodebuddy(size) {
    const c = newCanvas(size);
    const top = 1;
    const bottom = size - 5;
    const left = 1;
    const right = size - 2;
    rect(c, size, left, top, right, bottom);
    // Tail: solid block touching the bubble's bottom-left corner.
    for (let yy = bottom; yy < Math.min(size, bottom + 3); yy++) {
      for (let xx = Math.max(0, left - 2); xx < left + 1; xx++) {
        c[yy][xx] = 1;
      }
    }
    // Three dots knocked out of the fill, on the bubble's midline.
    const dotY = Math.floor((top + bottom) / 2);
    const spacing = Math.max(2, Math.floor((right - left) / 4));
    const cx = Math.floor((left + right) / 2);
    const ds = [-spacing, 0, spacing];
    for (let i = 0; i < ds.length; i++) {
      const xx = cx + ds[i];
      if (left + 1 <= xx && xx <= right - 1) c[dotY][xx] = 0;
    }
    return c;
  }

  // XBM rows: one byte per 8 pixels, bit 0 = leftmost (u8g2.drawXBM).
  // Bit-per-pixel, NOT byte-per-pixel: a 48px row is 6 bytes, not 48.
  function bitmapBytes(c, w, h) {
    const out = [];
    for (let y = 0; y < h; y++) {
      for (let x0 = 0; x0 < w; x0 += 8) {
        let b = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = x0 + bit;
          if (x < w && c[y][x]) b |= 1 << bit;
        }
        out.push(b);
      }
    }
    return out;
  }

  // --- per-editor state glyphs -----------------------------------------
  // The state set above (gear / hourglass / check / cross / warning / breath)
  // is the retired firmware-lineage Claude set, and the byte-exact port of
  // gen_icons.py's reference code.
  //
  // CodeBuddy's set below (a typing bubble for thinking, a ring spinner for
  // busy, a ringed check / cross for success / error, a bell for alarm, and
  // the shared breathing dot for idle) is likewise page-fallback only.
  //
  // Both editors' *primary* icons are the imported bitmap art app.js loads
  // at runtime (img/claudecode/*.png, img/codebuddy/*.jpg) and gen_icons.py
  // imports into icons.h. The procedural glyphs here exist so the page has
  // something to show before the art finishes loading or if a fetch fails.

  // A ring band lit only between angles a0..a1 (radians). With on=0 it clears
  // a wedge out of a drawn ring -- that is how the busy spinner shows its gap.
  function arcBand(c, size, cx, cy, r, thick, a0, a1, on) {
    if (on === undefined) on = 1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (!((r - thick) * (r - thick) < d2 && d2 <= r * r)) continue;
        const t = pymod(Math.atan2(dy, dx) - a0, 2 * Math.PI);
        if (t <= (a1 - a0)) c[y][x] = on;
      }
    }
  }

  // Speech bubble outline with a tail, the body of the thinking frame.
  function cbBubble(size) {
    const c = newCanvas(size);
    const m = size / 2 - 0.5;
    const r = size * 0.40;
    ring(c, size, m, m, r, Math.max(1, trunc(size * 0.11)));
    const tail = [
      [m - r * 0.55, m + r * 0.40],
      [m - r * 0.05, m + r * 0.50],
      [m - r * 0.05, m + r * 0.95],
      [m - r * 0.95, m + r * 0.50]
    ];
    drawPoly(c, size, tail);
    return c;
  }

  // Thinking: typing bubble, one of three dots enlarged per frame.
  function cbThinking(size, phase) {
    const c = cbBubble(size);
    const m = size / 2 - 0.5;
    const g = size * 0.16;
    const big = Math.max(1, trunc(size * 0.13));
    const small = Math.max(1, trunc(size * 0.08));
    for (let i = -1; i <= 1; i++) {
      const active = pymod(phase, 3) === (i + 1);
      disc(c, size, m + i * g, m, active ? big : small, 1);
    }
    return c;
  }

  // Busy: ring with a quarter gap that rotates between the two frames.
  function cbBusy(size, phase) {
    const c = newCanvas(size);
    const m = size / 2 - 0.5;
    const r = size * 0.40;
    const thick = Math.max(1, trunc(size * 0.11));
    ring(c, size, m, m, r, thick);
    const a0 = phase === 0 ? -Math.PI / 2 : Math.PI / 2;
    arcBand(c, size, m, m, r, thick, a0, a0 + Math.PI / 2, 0);
    return c;
  }

  // Success: check inside a ring, so it reads as CodeBuddy's, not Claude's bare
  // tick.
  function cbSuccess(size) {
    const c = newCanvas(size);
    const m = size / 2 - 0.5;
    const r = size * 0.40;
    ring(c, size, m, m, r, Math.max(1, trunc(size * 0.11)));
    const w = Math.max(1, trunc(size / 16));
    line(c, size, trunc(size * 0.22), trunc(m - size * 0.02),
         trunc(size * 0.42), trunc(size * 0.70), 1, w);
    line(c, size, trunc(size * 0.40), trunc(size * 0.70),
         trunc(size * 0.80), trunc(size * 0.28), 1, w);
    return c;
  }

  // Error: cross inside a ring; second frame empty so it blinks.
  function cbError(size, phase) {
    if (phase) return newCanvas(size);
    const c = newCanvas(size);
    const m = size / 2 - 0.5;
    const r = size * 0.40;
    ring(c, size, m, m, r, Math.max(1, trunc(size * 0.11)));
    const w = Math.max(1, trunc(size / 9));
    line(c, size, trunc(size * 0.30), trunc(size * 0.30),
         trunc(size * 0.70), trunc(size * 0.70), 1, w);
    line(c, size, trunc(size * 0.70), trunc(size * 0.30),
         trunc(size * 0.30), trunc(size * 0.70), 1, w);
    return c;
  }

  // Alarm: a bell (dome + mouth + clapper); second frame empty so it blinks.
  function cbAlarm(size, phase) {
    if (phase) return newCanvas(size);
    const c = newCanvas(size);
    const m = size / 2 - 0.5;
    const r = size * 0.34;
    disc(c, size, m, m, r, 1);
    const cut = m + size * 0.12;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (y > cut) c[y][x] = 0;
    line(c, size, trunc(m - r * 0.9), trunc(cut),
         trunc(m + r * 0.9), trunc(cut), 1, Math.max(1, trunc(size / 16)));
    disc(c, size, m, m + size * 0.30, Math.max(1, trunc(size * 0.06)));
    return c;
  }

  // Per-editor frame tables, indexed by SessionState value:
  //   0 unknown (drawn as thinking), 1..6 the glyphed states,
  //   7 ready (never drawn, but the table slot has to exist).
  // These feed app.js's pre-load fallback atlas; buildFrames(size) is the
  // plain Claude view kept for callers that want the retired set.
  function buildEditorFrames(editor, size) {
    const claude = {
      THINKING: [gear(size, 0), gear(size, 1 / 3), gear(size, 2 / 3)],
      BUSY: [hourglass(size, 0), hourglass(size, 1)],
      SUCCESS: [check(size)],
      ERROR: [cross(size), newCanvas(size)],
      ALARM: [warning(size), newCanvas(size)],
      IDLE: [breath(size, 0), breath(size, 1), breath(size, 2), breath(size, 3)],
      READY: [newCanvas(size)]
    };
    const codebuddy = {
      THINKING: [cbThinking(size, 0), cbThinking(size, 1), cbThinking(size, 2)],
      BUSY: [cbBusy(size, 0), cbBusy(size, 1)],
      SUCCESS: [cbSuccess(size)],
      ERROR: [cbError(size, 0), newCanvas(size)],
      ALARM: [cbAlarm(size, 0), newCanvas(size)],
      IDLE: [breath(size, 0), breath(size, 1), breath(size, 2), breath(size, 3)],
      READY: [newCanvas(size)]
    };
    const byName = editor === 'codebuddy' ? codebuddy : claude;
    const table = new Array(8);
    table[STATE_UNKNOWN] = byName.THINKING; // unknown is drawn as thinking
    for (let i = 0; i < DRAWN_STATES.length; i++) {
      table[i + 1] = byName[DRAWN_STATES[i].toUpperCase()];
    }
    table[STATE_READY] = byName.READY;
    return table;
  }

  function buildFrames(size) { return buildEditorFrames('claude', size); }

  // Editor name -> badge canvas, or null when the editor has no mark
  // (sessions.h::toEditor -> EDITOR_UNKNOWN).
  function buildBadge(editor, size) {
    if (editor === 'claude') return badgeClaude(size);
    if (editor === 'codebuddy') return badgeCodebuddy(size);
    return null;
  }

  return {
    SIZES, BADGE_W, BADGE_H,
    STATE_UNKNOWN, STATE_THINKING, STATE_BUSY, STATE_SUCCESS,
    STATE_ERROR, STATE_ALARM, STATE_IDLE, STATE_READY,
    DRAWN_STATES, FRAME_MS,
    newCanvas, rect, disc, ring, line, drawPoly,
    gear, hourglass, check, cross, warning, breath,
    badgeClaude, badgeCodebuddy,
    bitmapBytes, buildFrames, buildEditorFrames, buildBadge
  };
});
