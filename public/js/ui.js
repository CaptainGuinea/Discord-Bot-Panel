/* Rendering helpers: escaping, formatting, ANSI, charts, toasts, modals. */

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape before interpolating anything into a template string. */
export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** Builds a detached element from an HTML string. */
export function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

export const icon = (name, className = 'icon') =>
  `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * Event delegation — survives re-renders of `root`'s children, which plain
 * listeners do not.
 *
 * Attach this to an element that is created once per view, never inside a
 * function that redraws that element's contents: `root` itself survives an
 * innerHTML assignment, so re-running `on()` would stack a second listener and
 * fire every handler twice. Returns a disposer for the cases where you do need
 * to detach early.
 */
export function on(root, event, selector, handler) {
  const listener = (ev) => {
    const target = ev.target.closest(selector);
    if (target && root.contains(target)) handler(ev, target);
  };
  root.addEventListener(event, listener);
  return () => root.removeEventListener(event, listener);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function fmtDuration(ms) {
  const seconds = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function fmtAgo(timestamp) {
  if (!timestamp) return 'never';
  const delta = Date.now() - Number(timestamp);
  if (delta < 45_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.round(delta / 86_400_000)}d ago`;
  return new Date(Number(timestamp)).toLocaleDateString();
}

export const fmtTime = (timestamp) =>
  new Date(Number(timestamp)).toLocaleTimeString([], { hour12: false });

export const fmtDateTime = (timestamp) =>
  new Date(Number(timestamp)).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });

export const pct = (value) => `${Math.round(Number(value) || 0)}%`;

const STATUS_LABELS = {
  running: 'Running',
  stopped: 'Stopped',
  starting: 'Starting',
  stopping: 'Stopping',
  backoff: 'Restarting',
  crashed: 'Crashed',
};

export const statusLabel = (status) => STATUS_LABELS[status] ?? status;

export const statusBadge = (state) => {
  if (state?.deploying) {
    return `<span class="badge st-starting"><i class="dot"></i>Deploying</span>`;
  }
  const status = state?.status ?? 'stopped';
  return `<span class="badge st-${esc(status)}"><i class="dot"></i>${esc(statusLabel(status))}</span>`;
};

// ---------------------------------------------------------------------------
// ANSI → HTML
// ---------------------------------------------------------------------------

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, 'g');

/**
 * Converts SGR colour codes into spans. Anything we do not understand is
 * dropped rather than printed, so the console never shows escape gibberish.
 */
export function ansiToHtml(text) {
  const source = String(text ?? '');
  let html = '';
  let lastIndex = 0;
  let open = 0;
  let match;

  ANSI_RE.lastIndex = 0;
  while ((match = ANSI_RE.exec(source)) !== null) {
    html += esc(source.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;

    const codes = (match[1] || '0').split(';').map(Number);
    for (const code of codes) {
      if (code === 0) {
        html += '</span>'.repeat(open);
        open = 0;
      } else if (code === 1) { html += '<span class="ab">'; open++; }
      else if (code === 3) { html += '<span class="ai">'; open++; }
      else if (code === 4) { html += '<span class="au">'; open++; }
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        html += `<span class="a${code}">`;
        open++;
      }
    }
  }

  html += esc(source.slice(lastIndex));
  return html + '</span>'.repeat(open);
}

/** Highlights every case-insensitive occurrence of `needle` in escaped HTML. */
export function highlight(html, needle) {
  if (!needle) return html;
  const safe = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Only match outside of tags so we never break the markup ansiToHtml produced.
  return html.replace(new RegExp(`(${safe})(?![^<]*>)`, 'gi'), '<mark>$1</mark>');
}

// ---------------------------------------------------------------------------
// Charts — hand-rolled SVG, no library, no build step.
// ---------------------------------------------------------------------------

const ACCENT_HEX = {
  indigo: '#818cf8', violet: '#c084fc', sky: '#38bdf8', emerald: '#34d399',
  amber: '#fbbf24', rose: '#fb7185', cyan: '#22d3ee', lime: '#a3e635',
};
export const accentHex = (accent) => ACCENT_HEX[accent] ?? ACCENT_HEX.indigo;

/** Base and highlight pairs used for the instance-wide accent. */
const ACCENT_THEME = {
  indigo: ['#6366f1', '#818cf8'],
  violet: ['#8b5cf6', '#c084fc'],
  sky: ['#0ea5e9', '#38bdf8'],
  emerald: ['#10b981', '#34d399'],
  amber: ['#f59e0b', '#fbbf24'],
  rose: ['#f43f5e', '#fb7185'],
  cyan: ['#06b6d4', '#22d3ee'],
  lime: ['#65a30d', '#a3e635'],
};

/** Repaints the whole interface in the instance's chosen accent. */
export function applyAccent(name) {
  const [base, light] = ACCENT_THEME[name] ?? ACCENT_THEME.indigo;
  const root = document.documentElement.style;

  root.setProperty('--accent', base);
  root.setProperty('--accent-2', light);
  root.setProperty('--accent-soft', hexToRgba(base, 0.14));
  root.setProperty('--accent-line', hexToRgba(base, 0.35));
}

function hexToRgba(hex, alpha) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/** Compact trend line for cards. Values are plain numbers. */
export function sparkline(values, { color = '#818cf8', height = 34 } = {}) {
  const series = (values ?? []).filter((value) => Number.isFinite(value));
  if (series.length < 2) {
    return `<svg class="spark" viewBox="0 0 100 ${height}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="${height - 1}" x2="100" y2="${height - 1}" stroke="${color}" stroke-opacity=".25" stroke-width="1" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  const max = Math.max(...series, 1);
  const step = 100 / (series.length - 1);
  const toY = (value) => height - 2 - (value / max) * (height - 5);

  const points = series.map((value, index) => `${(index * step).toFixed(2)},${toY(value).toFixed(2)}`);
  const id = `g${Math.random().toString(36).slice(2, 8)}`;

  return `<svg class="spark" viewBox="0 0 100 ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".32"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="0,${height} ${points.join(' ')} 100,${height}" fill="url(#${id})"/>
    <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/**
 * Full-size area chart with a baseline grid and y-axis labels.
 * `points` is [{ ts, value }]; `format` renders the axis labels.
 */
export function areaChart(points, { color = '#818cf8', height = 170, format = (v) => v, label = '' } = {}) {
  const series = (points ?? []).filter((point) => Number.isFinite(point.value));
  if (series.length < 2) {
    return `<div class="empty" style="padding:36px"><p class="muted">Not enough data yet — samples arrive every few seconds.</p></div>`;
  }

  const width = 640;
  const padLeft = 46;
  const padBottom = 18;
  const padTop = 10;
  const plotWidth = width - padLeft - 8;
  const plotHeight = height - padTop - padBottom;

  const max = Math.max(...series.map((point) => point.value), 1) * 1.15;
  const stepX = plotWidth / (series.length - 1);
  const toY = (value) => padTop + plotHeight - (value / max) * plotHeight;

  const coords = series.map((point, index) => `${(padLeft + index * stepX).toFixed(1)},${toY(point.value).toFixed(1)}`);
  const id = `c${Math.random().toString(36).slice(2, 8)}`;

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = padTop + plotHeight * ratio;
    const value = max * (1 - ratio);
    return `<line class="chart-grid" x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - 8}" y2="${y.toFixed(1)}"/>
            <text class="chart-label" x="${padLeft - 7}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(format(value))}</text>`;
  }).join('');

  const first = fmtTime(series[0].ts);
  const last = fmtTime(series.at(-1).ts);

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".3"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${gridLines}
    <polygon points="${padLeft},${padTop + plotHeight} ${coords.join(' ')} ${(padLeft + (series.length - 1) * stepX).toFixed(1)},${padTop + plotHeight}" fill="url(#${id})"/>
    <polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    <text class="chart-label" x="${padLeft}" y="${height - 5}">${esc(first)}</text>
    <text class="chart-label" x="${width - 8}" y="${height - 5}" text-anchor="end">${esc(last)}</text>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const TOAST_ICONS = { ok: 'check', bad: 'alert', info: 'activity' };

export function toast(message, kind = 'info', timeout = 4200) {
  const host = $('#toasts');
  const node = el(`<div class="toast ${kind}">${icon(TOAST_ICONS[kind] ?? 'activity')}<div class="grow">${esc(message)}</div></div>`);
  host.appendChild(node);

  const dismiss = () => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  };
  node.addEventListener('click', dismiss);
  setTimeout(dismiss, timeout);
}

export const toastError = (err) =>
  toast(err?.message ?? String(err), 'bad', 6500);

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

/**
 * Opens a modal. `render(body, close)` fills the body; the returned promise
 * resolves with whatever `close(value)` was called with.
 */
export function modal({ title, render, actions = [], wide = false, onOpen }) {
  return new Promise((resolve) => {
    const back = el(`
      <div class="modal-back">
        <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h2>${esc(title)}</h2>
            <button class="icon-btn" data-close>${icon('x')}</button>
          </div>
          <div class="modal-body"></div>
          ${actions.length > 0 ? '<div class="modal-foot"></div>' : ''}
        </div>
      </div>`);

    const body = $('.modal-body', back);
    const foot = $('.modal-foot', back);

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      back.remove();
      resolve(value);
    };

    const onKey = (ev) => {
      if (ev.key === 'Escape') close(undefined);
    };

    if (typeof render === 'string') body.innerHTML = render;
    else render?.(body, close);

    for (const action of actions) {
      const button = el(`<button class="btn ${action.className ?? ''}">${action.icon ? icon(action.icon) : ''}${esc(action.label)}</button>`);
      button.addEventListener('click', async () => {
        if (action.onClick) {
          const result = await action.onClick(body, close, button);
          if (result !== false) close(action.value ?? true);
        } else {
          close(action.value ?? true);
        }
      });
      foot.appendChild(button);
    }

    back.addEventListener('click', (ev) => {
      if (ev.target === back || ev.target.closest('[data-close]')) close(undefined);
    });
    document.addEventListener('keydown', onKey);

    $('#modal-root').appendChild(back);
    onOpen?.(body, close);
    // Focus the first field so keyboard users can start typing immediately.
    setTimeout(() => $('input, textarea, select', body)?.focus(), 40);
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return modal({
    title,
    render: `<p class="muted" style="line-height:1.6">${esc(message)}</p>`,
    actions: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, className: danger ? 'btn-bad' : 'btn-primary', value: true },
    ],
  }).then((value) => value === true);
}

export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Save' }) {
  return modal({
    title,
    render: `<label class="field"><span>${esc(label)}</span>
      <input id="prompt-input" value="${esc(value)}" placeholder="${esc(placeholder)}" /></label>`,
    actions: [
      { label: 'Cancel', value: null },
      {
        label: confirmLabel,
        className: 'btn-primary',
        onClick: (body, close) => {
          close($('#prompt-input', body).value.trim());
          return false;
        },
      },
    ],
    onOpen: (body, close) => {
      $('#prompt-input', body).addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') close($('#prompt-input', body).value.trim());
      });
    },
  });
}

export async function copyToClipboard(text, message = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message, 'ok', 1800);
  } catch {
    // Clipboard API needs a secure context; plain http://10.x panels land here.
    const field = document.createElement('textarea');
    field.value = text;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    document.execCommand('copy');
    field.remove();
    toast(message, 'ok', 1800);
  }
}
