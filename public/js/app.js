import { api, live } from './api.js';
import {
  $, $$, esc, icon, on, toast, toastError, modal, confirmDialog, promptDialog,
  copyToClipboard, fmtBytes, fmtDuration, fmtAgo, fmtTime, fmtDateTime, pct,
  statusBadge, statusLabel, ansiToHtml, highlight, sparkline, areaChart, accentHex,
  applyAccent,
} from './ui.js';

/* ==========================================================================
   State
   ========================================================================== */

const state = {
  user: null,
  instance: { instanceName: 'BotPanel', instanceAccent: 'indigo', allowRegistration: false, version: '' },
  bots: [],
  states: {},            // botId -> supervisor snapshot
  host: null,
  sparks: new Map(),     // botId -> recent cpu values, for card sparklines
  runtimes: [],
  accents: [],
};

const byId = (botId) => state.bots.find((bot) => bot.id === botId);
const isAdmin = () => state.user?.role === 'admin';

/** Every view registers its cleanup here; the router runs them on navigation. */
let teardowns = [];
const cleanup = (fn) => teardowns.push(fn);

function runTeardowns() {
  for (const fn of teardowns.splice(0)) {
    try {
      fn();
    } catch (err) {
      console.error('[teardown]', err);
    }
  }
}

/* ==========================================================================
   Boot & authentication gate
   ========================================================================== */

async function boot() {
  try {
    const authState = await api.get('/auth/state');
    applyInstance(authState.instance);

    if (authState.user) {
      state.user = authState.user;
      await startApp();
    } else {
      showGate(authState.needsSetup ? 'setup' : 'login');
    }
  } catch (err) {
    showGate('login');
    setGateError('Cannot reach the API. Check that the server is running.');
    console.error(err);
  }
}

function applyInstance(instance) {
  if (!instance) return;
  state.instance = { ...state.instance, ...instance };

  applyAccent(state.instance.instanceAccent);
  document.title = state.instance.instanceName;
  const brand = $('#brand-name');
  if (brand) brand.textContent = state.instance.instanceName;
}

const GATE_COPY = {
  setup: {
    title: 'Welcome',
    sub: 'No account exists yet. Create the administrator account.',
    submit: 'Create account',
    endpoint: '/setup',
  },
  login: {
    title: 'Sign in',
    sub: 'Enter your credentials to continue.',
    submit: 'Sign in',
    endpoint: '/auth/login',
  },
  register: {
    title: 'Create an account',
    sub: 'Registration is open on this instance.',
    submit: 'Create account',
    endpoint: '/auth/register',
  },
};

function showGate(mode) {
  const copy = GATE_COPY[mode];
  $('#gate').hidden = false;
  $('#app').hidden = true;

  $('#gate-title').textContent = copy.title;
  $('#gate-sub').textContent = copy.sub;
  $('#gate-submit').textContent = copy.submit;
  $('#gate-email-field').hidden = mode === 'login';
  $('#gate-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#gate-foot').textContent = `${state.instance.instanceName}${state.instance.version ? ` · v${state.instance.version}` : ''}`;
  setGateError(null);

  const canRegister = state.instance.allowRegistration && mode !== 'setup';
  const alt = $('#gate-alt');
  alt.hidden = !canRegister;

  if (canRegister) {
    const toggle = $('#gate-toggle');
    toggle.textContent = mode === 'login' ? 'Create an account' : 'I already have an account';
    toggle.onclick = (ev) => {
      ev.preventDefault();
      showGate(mode === 'login' ? 'register' : 'login');
    };
  }

  $('#gate-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const button = $('#gate-submit');
    button.disabled = true;
    setGateError(null);

    const payload = {
      username: $('#gate-username').value.trim(),
      password: $('#gate-password').value,
    };
    if (mode !== 'login') payload.email = $('#gate-email').value.trim() || undefined;

    try {
      const result = await api.post(copy.endpoint, payload);
      state.user = result.user;
      $('#gate').hidden = true;
      await startApp();
    } catch (err) {
      setGateError(err.message);
      $('#gate-password').value = '';
      $('#gate-password').focus();
    } finally {
      button.disabled = false;
    }
  };
}

function setGateError(message) {
  const node = $('#gate-error');
  node.hidden = !message;
  node.textContent = message ?? '';
}

async function startApp() {
  $('#gate').hidden = true;
  $('#app').hidden = false;

  $('#who').innerHTML = `${esc(state.user.username)} <span class="role-pill ${isAdmin() ? 'admin' : ''}">${esc(state.user.role)}</span>`;
  $('#nav-admin').hidden = !isAdmin();
  $('#side-new').hidden = !isAdmin();

  await Promise.all([refreshBots(), loadRuntimes()]);

  live.connect();
  live.onState((connection) => {
    const dot = $('#ws-dot');
    dot.classList.toggle('live', connection === 'live');
    dot.classList.toggle('dead', connection !== 'live');
  });

  live.on('bots', (message) => {
    if (message.type === 'hello') {
      Object.assign(state.states, message.data.states);
    } else if (message.type === 'status') {
      state.states[message.data.botId] = message.data;
    } else if (message.type === 'deploy-end') {
      refreshBots();
    }
    renderSidebar();
    window.dispatchEvent(new CustomEvent('bots:changed', { detail: message }));
  });

  live.on('stats', (message) => {
    state.host = message.data.host;
    for (const [botId, sample] of Object.entries(message.data.bots)) {
      if (state.states[botId]) Object.assign(state.states[botId], sample);
      const series = state.sparks.get(botId) ?? [];
      series.push(sample.cpu);
      if (series.length > 40) series.shift();
      state.sparks.set(botId, series);
    }
    renderHostStrip();
    renderSidebarNumbers();
    window.dispatchEvent(new CustomEvent('stats:sample', { detail: message.data }));
  });

  wireChrome();
  window.addEventListener('hashchange', route);
  route();
}

async function refreshBots() {
  const { bots } = await api.get('/bots');
  state.bots = bots;
  for (const bot of bots) state.states[bot.id] = bot.state;
  renderSidebar();
}

async function loadRuntimes() {
  const data = await api.get('/runtimes');
  state.runtimes = data.runtimes;
  state.accents = data.accents;
}

/* ==========================================================================
   Shell chrome
   ========================================================================== */

function wireChrome() {
  $('#logout').onclick = async () => {
    await api.post('/auth/logout');
    location.reload();
  };
  $('#side-new').onclick = () => newBotDialog();
  $('#open-palette').onclick = () => openPalette();

  document.addEventListener('keydown', (ev) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName);

    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      openPalette();
      return;
    }
    if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;

    if (ev.key === 'n' && isAdmin()) {
      ev.preventDefault();
      newBotDialog();
    } else if (ev.key === '/') {
      ev.preventDefault();
      openPalette();
    } else if (ev.key === 'g') {
      // `g` then `h` jumps home, vim style.
      const once = (next) => {
        if (next.key === 'h') location.hash = '#/';
        document.removeEventListener('keydown', once);
      };
      document.addEventListener('keydown', once);
    }
  });
}

function renderSidebar() {
  const host = $('#side-bots');
  const currentId = location.hash.match(/^#\/bot\/([^/]+)/)?.[1];

  if (state.bots.length === 0) {
    host.innerHTML = `<p class="muted" style="padding:8px 10px;font-size:12.5px">No bots yet.</p>`;
    return;
  }

  host.innerHTML = state.bots.map((bot) => {
    const snapshot = state.states[bot.id] ?? {};
    return `<a class="side-bot ${bot.id === currentId ? 'active' : ''}" href="#/bot/${esc(bot.id)}"
               data-status="${esc(snapshot.status ?? 'stopped')}" data-bot="${esc(bot.id)}"
               style="--bot-accent:${accentHex(bot.accent)}">
      <i class="sb-dot"></i>
      <span class="sb-name">${esc(bot.name)}</span>
      <span class="sb-cpu" data-cpu="${esc(bot.id)}">${snapshot.status === 'running' ? `${Math.round(snapshot.cpu ?? 0)}%` : ''}</span>
    </a>`;
  }).join('');
}

/** Cheap per-tick update — avoids rebuilding the sidebar every three seconds. */
function renderSidebarNumbers() {
  for (const bot of state.bots) {
    const snapshot = state.states[bot.id] ?? {};
    const cpuNode = $(`[data-cpu="${CSS.escape(bot.id)}"]`);
    if (cpuNode) cpuNode.textContent = snapshot.status === 'running' ? `${Math.round(snapshot.cpu ?? 0)}%` : '';
    const row = $(`[data-bot="${CSS.escape(bot.id)}"]`);
    if (row) row.dataset.status = snapshot.status ?? 'stopped';
  }
}

function renderHostStrip() {
  const host = state.host;
  if (!host) return;

  const memPercent = (host.memUsed / host.memTotal) * 100;
  const diskPercent = host.disk.total ? (host.disk.used / host.disk.total) * 100 : 0;

  $('#host-strip').innerHTML = `
    <span class="hs" title="Host CPU across ${host.cores} cores">${icon('cpu')}<b>${pct(host.cpu)}</b></span>
    <span class="hs" title="Memory ${fmtBytes(host.memUsed)} of ${fmtBytes(host.memTotal)}">${icon('memory')}<b>${pct(memPercent)}</b></span>
    <span class="hs" title="Disk ${fmtBytes(host.disk.used)} of ${fmtBytes(host.disk.total)}">${icon('disk')}<b>${pct(diskPercent)}</b></span>
    <span class="hs" title="Host uptime">${icon('clock')}<b>${fmtDuration(host.uptime * 1000)}</b></span>`;
}

function setCrumbs(parts) {
  $('#crumbs').innerHTML = parts
    .map((part, index) =>
      index === parts.length - 1
        ? `<strong>${esc(part.label)}</strong>`
        : `<a href="${esc(part.href ?? '#/')}">${esc(part.label)}</a><span class="sep">${icon('chevron')}</span>`)
    .join('');
}

function setNav(name) {
  for (const item of $$('.nav-item')) {
    item.classList.toggle('active', item.dataset.nav === name);
  }
}

/* ==========================================================================
   Router
   ========================================================================== */

function route() {
  runTeardowns();
  const hash = location.hash.replace(/^#/, '') || '/';
  const segments = hash.split('/').filter(Boolean);
  const view = $('#view');
  view.scrollTop = 0;

  if (segments[0] === 'bot' && segments[1]) {
    renderBot(view, segments[1], segments[2] ?? 'console');
  } else if (segments[0] === 'activity') {
    renderActivity(view);
  } else if (segments[0] === 'settings') {
    renderSettings(view);
  } else if (segments[0] === 'admin') {
    renderAdmin(view);
  } else {
    renderOverview(view);
  }
  renderSidebar();
}

/* ==========================================================================
   Overview
   ========================================================================== */

function renderOverview(view) {
  setNav('overview');
  setCrumbs([{ label: 'Overview' }]);

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Overview</h1>
        <p class="sub">${state.bots.length} bot${state.bots.length === 1 ? '' : 's'} on this host</p>
      </div>
      <div class="row">
        <button class="btn" id="ov-refresh">${icon('refresh')}Refresh</button>
        ${isAdmin() ? `<button class="btn btn-primary" id="ov-new">${icon('plus')}New bot</button>` : ''}
      </div>
    </div>
    <div class="tiles" id="ov-tiles"></div>
    <div id="ov-grid"></div>`;

  if (isAdmin()) $('#ov-new').onclick = () => newBotDialog();
  $('#ov-refresh').onclick = async () => {
    await refreshBots();
    drawOverviewGrid();
    toast('Refreshed', 'ok', 1500);
  };

  drawTiles();
  drawOverviewGrid();

  // Attached once against the container, not inside drawOverviewGrid — that
  // function reruns on every status change and would stack duplicate handlers.
  on($('#ov-grid'), 'click', '[data-action]', async (ev, node) => {
    ev.preventDefault();
    await botAction(node.dataset.bot, node.dataset.action, node);
  });

  const onStats = () => {
    drawTiles();
    updateCardNumbers();
  };
  const onBots = () => drawOverviewGrid();
  window.addEventListener('stats:sample', onStats);
  window.addEventListener('bots:changed', onBots);
  cleanup(() => {
    window.removeEventListener('stats:sample', onStats);
    window.removeEventListener('bots:changed', onBots);
  });
}

function drawTiles() {
  const host = state.host;
  const snapshots = state.bots.map((bot) => state.states[bot.id] ?? {});
  const running = snapshots.filter((snapshot) => snapshot.status === 'running').length;
  const unhealthy = snapshots.filter((snapshot) => ['crashed', 'backoff'].includes(snapshot.status)).length;
  const botMemory = snapshots.reduce((sum, snapshot) => sum + (snapshot.mem ?? 0), 0);

  const memPercent = host ? (host.memUsed / host.memTotal) * 100 : 0;
  const level = (value) => (value > 88 ? 'is-bad' : value > 70 ? 'is-warn' : '');

  const tiles = $('#ov-tiles');
  if (!tiles) return;

  tiles.innerHTML = `
    <div class="tile">
      <div class="t-label">${icon('bot')}Bots online</div>
      <div class="t-value">${running}<small>/ ${state.bots.length}</small></div>
      <div class="t-sub">${unhealthy > 0 ? `${unhealthy} need attention` : 'All healthy'}</div>
      <div class="meter ${unhealthy > 0 ? 'is-warn' : ''}"><i style="width:${state.bots.length ? (running / state.bots.length) * 100 : 0}%"></i></div>
    </div>
    <div class="tile">
      <div class="t-label">${icon('cpu')}Host CPU</div>
      <div class="t-value">${pct(host?.cpu ?? 0)}</div>
      <div class="t-sub">${host ? `${host.cores} cores · load ${host.load[0].toFixed(2)}` : '—'}</div>
      <div class="meter ${level(host?.cpu ?? 0)}"><i style="width:${Math.min(host?.cpu ?? 0, 100)}%"></i></div>
    </div>
    <div class="tile">
      <div class="t-label">${icon('memory')}Memory</div>
      <div class="t-value">${host ? fmtBytes(host.memUsed) : '—'}</div>
      <div class="t-sub">${host ? `of ${fmtBytes(host.memTotal)} · bots use ${fmtBytes(botMemory)}` : '—'}</div>
      <div class="meter ${level(memPercent)}"><i style="width:${memPercent}%"></i></div>
    </div>
    <div class="tile">
      <div class="t-label">${icon('disk')}Disk</div>
      <div class="t-value">${host ? fmtBytes(host.disk.free) : '—'}<small>free</small></div>
      <div class="t-sub">${host ? `${fmtBytes(host.disk.used)} used of ${fmtBytes(host.disk.total)}` : '—'}</div>
      <div class="meter ${level(host?.disk.total ? (host.disk.used / host.disk.total) * 100 : 0)}">
        <i style="width:${host?.disk.total ? (host.disk.used / host.disk.total) * 100 : 0}%"></i>
      </div>
    </div>`;
}

function drawOverviewGrid() {
  const grid = $('#ov-grid');
  if (!grid) return;

  if (state.bots.length === 0) {
    grid.innerHTML = `
      <div class="empty">
        ${icon('bot', 'icon')}
        <h2>No bots yet</h2>
        <p>Add a bot from a Git repository. The panel clones it, installs its dependencies and keeps it running.</p>
        ${isAdmin()
          ? `<button class="btn btn-primary" id="empty-new">${icon('plus')}Add a bot</button>`
          : '<p class="faint">Ask an administrator to add one.</p>'}
      </div>`;
    if (isAdmin()) $('#empty-new').onclick = () => newBotDialog();
    return;
  }

  grid.innerHTML = `<div class="bot-grid">${state.bots.map(botCard).join('')}</div>`;
}

function botCard(bot) {
  const snapshot = state.states[bot.id] ?? {};
  const running = snapshot.status === 'running';
  const initials = bot.name.slice(0, 2).toUpperCase();
  const spark = sparkline(state.sparks.get(bot.id) ?? [], { color: accentHex(bot.accent) });

  return `
  <article class="bot-card" style="--bot-accent:${accentHex(bot.accent)}" data-card="${esc(bot.id)}">
    <div class="bc-head">
      <div class="bc-mark">${esc(initials)}</div>
      <div class="bc-title">
        <a href="#/bot/${esc(bot.id)}">${esc(bot.name)}</a>
        <div class="bc-meta">${esc(bot.description || bot.runtime)}</div>
      </div>
      <span data-badge="${esc(bot.id)}">${statusBadge(snapshot)}</span>
    </div>

    <div class="bc-stats">
      <div class="bc-stat"><div class="k">Uptime</div><div class="v" data-uptime="${esc(bot.id)}">${running ? fmtDuration(snapshot.uptime) : '—'}</div></div>
      <div class="bc-stat"><div class="k">CPU</div><div class="v" data-cpuv="${esc(bot.id)}">${running ? `${(snapshot.cpu ?? 0).toFixed(1)}%` : '—'}</div></div>
      <div class="bc-stat"><div class="k">Memory</div><div class="v" data-memv="${esc(bot.id)}">${running ? fmtBytes(snapshot.mem) : '—'}</div></div>
    </div>

    <div style="padding:0 16px">${spark}</div>

    <div class="bc-actions">
      <div class="grow">
        ${running
          ? `<button class="btn btn-sm btn-warn" data-bot="${esc(bot.id)}" data-action="restart">${icon('restart')}Restart</button>
             <button class="btn btn-sm" data-bot="${esc(bot.id)}" data-action="stop">${icon('stop')}Stop</button>`
          : `<button class="btn btn-sm btn-ok" data-bot="${esc(bot.id)}" data-action="start">${icon('play')}Start</button>`}
        <button class="btn btn-sm" data-bot="${esc(bot.id)}" data-action="deploy" title="Pull and redeploy">${icon('rocket')}Deploy</button>
      </div>
      <a class="btn btn-sm btn-ghost" href="#/bot/${esc(bot.id)}/console" title="Open console">${icon('terminal')}</a>
    </div>
  </article>`;
}

/** Updates only the numbers inside cards, so hovering and sparklines survive. */
function updateCardNumbers() {
  for (const bot of state.bots) {
    const snapshot = state.states[bot.id] ?? {};
    const running = snapshot.status === 'running';
    const set = (selector, value) => {
      const node = $(`[${selector}="${CSS.escape(bot.id)}"]`);
      if (node) node.textContent = value;
    };
    set('data-uptime', running ? fmtDuration(snapshot.uptime) : '—');
    set('data-cpuv', running ? `${(snapshot.cpu ?? 0).toFixed(1)}%` : '—');
    set('data-memv', running ? fmtBytes(snapshot.mem) : '—');

    const badge = $(`[data-badge="${CSS.escape(bot.id)}"]`);
    if (badge) badge.innerHTML = statusBadge(snapshot);

    const card = $(`[data-card="${CSS.escape(bot.id)}"] .spark`);
    if (card) {
      card.outerHTML = sparkline(state.sparks.get(bot.id) ?? [], { color: accentHex(bot.accent) });
    }
  }
}

/* ==========================================================================
   Bot actions
   ========================================================================== */

async function botAction(botId, action, button) {
  const bot = byId(botId);
  if (!bot) return;

  if (button) button.disabled = true;
  try {
    if (action === 'deploy') {
      await deployDialog(bot);
    } else if (action === 'delete') {
      const ok = await confirmDialog({
        title: `Delete ${bot.name}?`,
        message: `This stops the bot and permanently removes its files, logs and settings. Backups are kept. This cannot be undone.`,
        confirmLabel: 'Delete bot',
        danger: true,
      });
      if (!ok) return;
      await api.del(`/bots/${botId}`);
      await refreshBots();
      toast(`${bot.name} deleted`, 'ok');
      if (location.hash.includes(botId)) location.hash = '#/';
    } else {
      await api.post(`/bots/${botId}/${action}`);
      toast(`${bot.name}: ${action}`, 'ok', 2000);
    }
  } catch (err) {
    toastError(err);
  } finally {
    if (button) button.disabled = false;
  }
}

/* ==========================================================================
   Bot detail
   ========================================================================== */

const TABS = [
  { id: 'console', label: 'Console', icon: 'terminal' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'env', label: 'Environment', icon: 'key' },
  { id: 'git', label: 'Git & deploys', icon: 'branch' },
  { id: 'metrics', label: 'Metrics', icon: 'chart' },
  { id: 'settings', label: 'Settings', icon: 'settings', adminOnly: true },
];

const visibleTabs = () => TABS.filter((tab) => !tab.adminOnly || isAdmin());

async function renderBot(view, botId, tab) {
  setNav(null);
  view.innerHTML = `<p class="muted">Loading…</p>`;

  let detail;
  try {
    detail = await api.get(`/bots/${botId}`);
  } catch (err) {
    view.innerHTML = `<div class="empty">${icon('alert')}<h2>Bot not found</h2><p>${esc(err.message)}</p>
      <a class="btn" href="#/">Back to overview</a></div>`;
    return;
  }

  const bot = detail.bot;
  if (!byId(bot.id)) state.bots.push(bot);
  state.states[bot.id] = bot.state;
  setCrumbs([{ label: 'Bots', href: '#/' }, { label: bot.name }]);

  view.innerHTML = `
    <div class="bot-head" style="--bot-accent:${accentHex(bot.accent)}">
      <div class="bc-mark">${esc(bot.name.slice(0, 2).toUpperCase())}</div>
      <div>
        <h1>${esc(bot.name)}</h1>
        <div class="sub">
          <span data-badge="${esc(bot.id)}">${statusBadge(bot.state)}</span>
          <span>${esc(bot.runtime)}</span>
          ${detail.git?.repo ? `<span>${icon('branch')} ${esc(detail.git.branch)}</span>` : ''}
          ${bot.description ? `<span>· ${esc(bot.description)}</span>` : ''}
        </div>
      </div>
      <div class="bot-actions" id="bot-actions"></div>
    </div>

    <div class="tabs">
      ${visibleTabs().map((entry) => `<a class="tab ${entry.id === tab ? 'active' : ''}" href="#/bot/${esc(bot.id)}/${entry.id}">${icon(entry.icon)}${esc(entry.label)}</a>`).join('')}
    </div>
    <div id="tab-body"></div>`;

  drawBotActions(bot);

  const onBots = () => {
    const snapshot = state.states[bot.id];
    const badge = $(`[data-badge="${CSS.escape(bot.id)}"]`);
    if (badge && snapshot) badge.innerHTML = statusBadge(snapshot);
    drawBotActions(bot);
  };
  window.addEventListener('bots:changed', onBots);
  cleanup(() => window.removeEventListener('bots:changed', onBots));

  const body = $('#tab-body');
  const renderers = {
    console: tabConsole,
    files: tabFiles,
    env: tabEnv,
    git: tabGit,
    metrics: tabMetrics,
    settings: tabSettings,
  };

  const allowed = visibleTabs().some((entry) => entry.id === tab);
  (allowed ? renderers[tab] ?? tabConsole : tabConsole)(body, bot, detail);
}

function drawBotActions(bot) {
  const host = $('#bot-actions');
  if (!host) return;

  const snapshot = state.states[bot.id] ?? {};
  const running = ['running', 'starting', 'stopping'].includes(snapshot.status);

  host.innerHTML = `
    ${running
      ? `<button class="btn btn-warn" data-bot="${esc(bot.id)}" data-action="restart">${icon('restart')}Restart</button>
         <button class="btn" data-bot="${esc(bot.id)}" data-action="stop">${icon('stop')}Stop</button>
         <button class="btn btn-ghost" data-bot="${esc(bot.id)}" data-action="kill" title="Force kill">${icon('alert')}</button>`
      : `<button class="btn btn-ok" data-bot="${esc(bot.id)}" data-action="start">${icon('play')}Start</button>`}
    <button class="btn btn-primary" data-bot="${esc(bot.id)}" data-action="deploy">${icon('rocket')}Deploy</button>`;

  for (const button of $$('[data-action]', host)) {
    button.onclick = () => botAction(bot.id, button.dataset.action, button);
  }
}

/* ---------------------------------------------------------------- Console -- */

function tabConsole(body, bot) {
  body.innerHTML = `
    <div class="console-wrap">
      <div class="console">
        <div class="console-bar">
          <input type="text" id="log-filter" placeholder="Filter output…" />
          <span class="muted" id="log-count"></span>
          <div class="grow"></div>
          <label class="switch" title="Scroll to new output"><input type="checkbox" id="log-follow" checked /><span class="track"></span><span class="muted">Follow</span></label>
          <button class="icon-btn" id="log-download" title="Download log file">${icon('download')}</button>
          <button class="icon-btn danger" id="log-clear" title="Clear console">${icon('trash')}</button>
        </div>
        <div class="console-out" id="log-out"></div>
        <div class="console-in">
          <input type="text" id="log-stdin" placeholder="Send a line to the bot's stdin…" />
          <button class="btn btn-sm" id="log-send">Send</button>
        </div>
      </div>
      <button class="btn btn-sm btn-primary follow-pill" id="log-jump" hidden>${icon('chevron')}Jump to newest</button>
    </div>`;

  const out = $('#log-out');
  const filterInput = $('#log-filter');
  const followBox = $('#log-follow');
  const jump = $('#log-jump');
  const MAX_NODES = 2500;
  let filterText = '';

  const matches = (line) => !filterText || line.text.toLowerCase().includes(filterText);

  const lineHtml = (line) => `<div class="ln ${esc(line.stream)}">
      <span class="t">${esc(fmtTime(line.ts))}</span>
      <span class="m">${highlight(ansiToHtml(line.text), filterText)}</span>
    </div>`;

  const stickToBottom = () => {
    if (followBox.checked) out.scrollTop = out.scrollHeight;
  };

  const append = (line) => {
    if (!matches(line)) return;
    out.insertAdjacentHTML('beforeend', lineHtml(line));
    while (out.childElementCount > MAX_NODES) out.firstElementChild.remove();
    stickToBottom();
  };

  let allLines = [];

  const repaint = () => {
    const visible = allLines.filter(matches);
    out.innerHTML = visible.length > 0
      ? visible.map(lineHtml).join('')
      : `<div class="ln"><span class="m muted">${filterText ? 'Nothing matches that filter.' : 'No output yet. Start the bot to see its console here.'}</span></div>`;
    $('#log-count').textContent = filterText ? `${visible.length} matching` : '';
    stickToBottom();
  };

  api.get(`/bots/${bot.id}/logs?limit=1500`)
    .then(({ lines }) => {
      allLines = lines;
      repaint();
      out.scrollTop = out.scrollHeight;
    })
    .catch(toastError);

  const channel = `logs:${bot.id}`;
  live.subscribe([channel]);
  const off = live.on(channel, (message) => {
    if (message.type === 'cleared') {
      allLines = [];
      repaint();
      return;
    }
    allLines.push(message.data);
    if (allLines.length > 4000) allLines = allLines.slice(-3000);
    append(message.data);
  });
  cleanup(() => {
    off();
    live.unsubscribe([channel]);
  });

  let filterTimer;
  filterInput.oninput = () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      filterText = filterInput.value.trim().toLowerCase();
      repaint();
    }, 140);
  };

  // Turning off follow when the user scrolls up is what makes reading history
  // possible on a chatty bot.
  out.addEventListener('scroll', () => {
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    if (!atBottom && followBox.checked) followBox.checked = false;
    jump.hidden = atBottom;
  });

  jump.onclick = () => {
    followBox.checked = true;
    out.scrollTop = out.scrollHeight;
    jump.hidden = true;
  };

  $('#log-download').onclick = () => {
    window.location.href = `/api/bots/${bot.id}/logs/download`;
  };

  $('#log-clear').onclick = async () => {
    if (!(await confirmDialog({ title: 'Clear console?', message: 'Removes the stored log file and the buffered output.', confirmLabel: 'Clear', danger: true }))) return;
    await api.del(`/bots/${bot.id}/logs`);
    allLines = [];
    repaint();
  };

  const send = async () => {
    const input = $('#log-stdin');
    const text = input.value.trim();
    if (!text) return;
    try {
      await api.post(`/bots/${bot.id}/stdin`, { text });
      input.value = '';
    } catch (err) {
      toastError(err);
    }
  };
  $('#log-send').onclick = send;
  $('#log-stdin').onkeydown = (ev) => {
    if (ev.key === 'Enter') send();
  };
}

/* ------------------------------------------------------------------ Files -- */

function tabFiles(body, bot) {
  body.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div class="path-bar" id="fm-path"></div>
        <div class="row">
          ${isAdmin() ? `
            <button class="btn btn-sm" id="fm-newfile">${icon('plus')}File</button>
            <button class="btn btn-sm" id="fm-newdir">${icon('folder')}Folder</button>` : ''}
          <button class="icon-btn" id="fm-reload" title="Reload">${icon('refresh')}</button>
        </div>
      </div>
      <div class="card-body tight" id="fm-list"></div>
    </div>
    ${isAdmin()
      ? '<p class="muted" style="margin-top:10px;font-size:12.5px">Drop a text file onto the list to upload it into the current folder.</p>'
      : '<p class="muted" style="margin-top:10px;font-size:12.5px">Files are read-only for your account.</p>'}`;

  let currentPath = '';

  const load = async (path) => {
    currentPath = path;
    try {
      const listing = await api.get(`/bots/${bot.id}/files?path=${encodeURIComponent(path)}`);
      drawPath(listing);
      drawList(listing);
    } catch (err) {
      toastError(err);
    }
  };

  const drawPath = (listing) => {
    const segments = listing.path ? listing.path.split('/').filter(Boolean) : [];
    const crumbs = [`<a href="#" data-go="">${esc(bot.name)}</a>`];
    segments.forEach((segment, index) => {
      const target = segments.slice(0, index + 1).join('/');
      crumbs.push(`<span class="sep">/</span><a href="#" data-go="${esc(target)}">${esc(segment)}</a>`);
    });
    $('#fm-path').innerHTML = crumbs.join('');
  };

  const drawList = (listing) => {
    const host = $('#fm-list');
    const up = listing.path
      ? `<div class="file-row" data-type="dir"><svg class="icon"><use href="#i-folder"/></svg>
           <span class="fname link" data-go="${esc(listing.path.split('/').slice(0, -1).join('/'))}">..</span></div>`
      : '';

    if (listing.entries.length === 0 && !listing.path) {
      host.innerHTML = `<div class="empty" style="border:none;padding:40px">${icon('folder')}<p>This bot has no files yet. Deploy from Git, or create a file here.</p></div>`;
      return;
    }

    host.innerHTML = up + listing.entries.map((entry) => `
      <div class="file-row" data-type="${esc(entry.type)}" data-name="${esc(entry.name)}">
        ${icon(entry.type === 'dir' ? 'folder' : 'file')}
        <span class="fname ${entry.type === 'dir' || entry.editable ? 'link' : ''}"
              ${entry.type === 'dir' ? `data-go="${esc(join(listing.path, entry.name))}"` : entry.editable ? `data-edit="${esc(join(listing.path, entry.name))}"` : ''}>${esc(entry.name)}</span>
        <span class="fsize">${entry.type === 'dir' ? '' : fmtBytes(entry.size)}</span>
        <span class="fsize">${entry.mtime ? fmtAgo(entry.mtime) : ''}</span>
        <span class="facts">
          ${entry.type === 'file' ? `<button class="icon-btn" data-download="${esc(join(listing.path, entry.name))}" title="Download">${icon('download')}</button>` : ''}
          ${isAdmin() ? `
            <button class="icon-btn" data-rename="${esc(join(listing.path, entry.name))}" title="Rename">${icon('file')}</button>
            <button class="icon-btn danger" data-del="${esc(join(listing.path, entry.name))}" title="Delete">${icon('trash')}</button>` : ''}
        </span>
      </div>`).join('');
  };

  const join = (base, name) => (base ? `${base}/${name}` : name);

  body.addEventListener('click', async (ev) => {
    const goNode = ev.target.closest('[data-go]');
    if (goNode) {
      ev.preventDefault();
      return load(goNode.dataset.go);
    }

    const editNode = ev.target.closest('[data-edit]');
    if (editNode) return openEditor(bot, editNode.dataset.edit, () => load(currentPath));

    const downloadNode = ev.target.closest('[data-download]');
    if (downloadNode) {
      window.location.href = `/api/bots/${bot.id}/files/download?path=${encodeURIComponent(downloadNode.dataset.download)}`;
      return;
    }

    const renameNode = ev.target.closest('[data-rename]');
    if (renameNode) {
      const from = renameNode.dataset.rename;
      const next = await promptDialog({ title: 'Rename', label: 'New path (relative to the bot root)', value: from });
      if (!next || next === from) return;
      try {
        await api.post(`/bots/${bot.id}/files/rename`, { from, to: next });
        load(currentPath);
      } catch (err) {
        toastError(err);
      }
      return;
    }

    const deleteNode = ev.target.closest('[data-del]');
    if (deleteNode) {
      const target = deleteNode.dataset.del;
      const ok = await confirmDialog({ title: 'Delete?', message: `${target} will be removed permanently.`, confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await api.del(`/bots/${bot.id}/files?path=${encodeURIComponent(target)}`);
        load(currentPath);
      } catch (err) {
        toastError(err);
      }
    }
  });

  $('#fm-reload').onclick = () => load(currentPath);

  const create = async (type) => {
    const name = await promptDialog({ title: type === 'dir' ? 'New folder' : 'New file', label: 'Name' });
    if (!name) return;
    try {
      await api.post(`/bots/${bot.id}/files/create`, { path: join(currentPath, name), type });
      load(currentPath);
    } catch (err) {
      toastError(err);
    }
  };
  if (isAdmin()) {
    $('#fm-newfile').onclick = () => create('file');
    $('#fm-newdir').onclick = () => create('dir');
  }

  // Drag-and-drop upload covers configs and single scripts without needing a
  // multipart endpoint.
  const list = $('#fm-list');
  const stop = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  list.addEventListener('dragover', (ev) => {
    stop(ev);
    list.style.outline = '2px dashed var(--accent)';
  });
  list.addEventListener('dragleave', (ev) => {
    stop(ev);
    list.style.outline = '';
  });
  list.addEventListener('drop', async (ev) => {
    stop(ev);
    list.style.outline = '';
    if (!isAdmin()) return;

    for (const file of ev.dataTransfer.files) {
      if (file.size > 2 * 1024 * 1024) {
        toast(`${file.name} is too large to upload here (2 MB limit)`, 'bad');
        continue;
      }
      try {
        const content = await file.text();
        await api.put(`/bots/${bot.id}/files/write`, { path: join(currentPath, file.name), content });
        toast(`Uploaded ${file.name}`, 'ok');
      } catch (err) {
        toastError(err);
      }
    }
    load(currentPath);
  });

  load('');
}

async function openEditor(bot, path, onSaved) {
  let file;
  try {
    file = await api.get(`/bots/${bot.id}/files/read?path=${encodeURIComponent(path)}`);
  } catch (err) {
    return toastError(err);
  }

  await modal({
    title: path,
    wide: true,
    render: (body) => {
      body.innerHTML = `<textarea class="editor" spellcheck="false" ${isAdmin() ? '' : 'readonly'}>${esc(file.content)}</textarea>
        <p class="muted" style="font-size:12px">${fmtBytes(file.size)} · last modified ${fmtAgo(file.mtime)}</p>`;
    },
    actions: isAdmin() ? [
      { label: 'Cancel' },
      {
        label: 'Save',
        className: 'btn-primary',
        icon: 'save',
        onClick: async (body, close) => {
          try {
            await api.put(`/bots/${bot.id}/files/write`, { path, content: $('textarea', body).value });
            toast('Saved', 'ok');
            onSaved?.();
            close(true);
          } catch (err) {
            toastError(err);
          }
          return false;
        },
      },
    ] : [{ label: 'Close' }],
  });
}

/* -------------------------------------------------------------- Environment */

async function tabEnv(body, bot) {
  body.innerHTML = `<p class="muted">Loading…</p>`;

  let rows;
  try {
    rows = (await api.get(`/bots/${bot.id}/env`)).env;
  } catch (err) {
    return toastError(err);
  }

  let revealed = false;

  const draw = () => {
    body.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div>
            <h2>Environment variables</h2>
            <p class="muted" style="font-size:12px">Injected into the process, and written to <code class="mono">.env</code>${bot.writeEnvFile ? '' : ' (file writing is off)'}.</p>
          </div>
          <div class="row">
            ${isAdmin() ? `
              <button class="btn btn-sm" id="env-reveal">${icon(revealed ? 'eye-off' : 'eye')}${revealed ? 'Hide' : 'Reveal'} secrets</button>
              <button class="btn btn-sm" id="env-import">${icon('download')}Import .env</button>
              <button class="btn btn-sm btn-primary" id="env-save">${icon('save')}Save</button>` : ''}
          </div>
        </div>
        <div class="card-body">
          <div class="env-head"><span>Key</span><span>Value</span><span></span></div>
          <div id="env-rows"></div>
          ${isAdmin() ? `<button class="btn btn-sm" id="env-add" style="margin-top:12px">${icon('plus')}Add variable</button>` : ''}
        </div>
      </div>
      <p class="muted" style="margin-top:12px;font-size:12.5px">
        ${isAdmin()
          ? 'Changes take effect the next time the bot starts. Save, then restart.'
          : 'Only administrators can change environment variables.'}
      </p>`;

    drawRows();
    wire();
  };

  const drawRows = () => {
    const host = $('#env-rows');
    if (rows.length === 0) {
      host.innerHTML = `<p class="muted" style="padding:14px 0;font-size:13px">No variables yet — add <code class="mono">DISCORD_TOKEN</code> to get started.</p>`;
      return;
    }
    host.innerHTML = rows.map((row, index) => `
      <div class="env-row ${row.masked && !revealed ? 'masked' : ''}">
        <input class="k mono" data-i="${index}" data-f="key" value="${esc(row.key)}" placeholder="KEY" spellcheck="false" ${isAdmin() ? '' : 'readonly'} />
        <input class="v mono" data-i="${index}" data-f="value" type="${row.isSecret && !revealed ? 'password' : 'text'}"
               value="${esc(row.masked && !revealed ? '' : row.value ?? '')}"
               placeholder="${row.masked && !revealed ? '•••••••• hidden' : 'value'}" spellcheck="false" ${isAdmin() ? '' : 'readonly'} />
        <span class="env-actions">
          ${isAdmin() ? `
            <button class="icon-btn" data-secret="${index}" title="${row.isSecret ? 'Marked secret' : 'Mark as secret'}" style="${row.isSecret ? 'color:var(--warn)' : ''}">${icon('key')}</button>
            <button class="icon-btn danger" data-rm="${index}" title="Remove">${icon('trash')}</button>` : ''}
        </span>
      </div>`).join('');
  };

  const wire = () => {
    if (!isAdmin()) return;

    on($('#env-rows'), 'input', 'input', (_ev, input) => {
      const row = rows[Number(input.dataset.i)];
      if (input.dataset.f === 'key') row.key = input.value;
      else {
        row.value = input.value;
        row.masked = false; // the user typed a real value, so send it through
      }
    });

    on($('#env-rows'), 'click', '[data-rm]', (_ev, button) => {
      rows.splice(Number(button.dataset.rm), 1);
      drawRows();
    });

    on($('#env-rows'), 'click', '[data-secret]', (_ev, button) => {
      const row = rows[Number(button.dataset.secret)];
      row.isSecret = !row.isSecret;
      drawRows();
    });

    $('#env-add').onclick = () => {
      rows.push({ key: '', value: '', isSecret: false, masked: false });
      drawRows();
      $$('#env-rows .k').at(-1)?.focus();
    };

    $('#env-reveal').onclick = async () => {
      revealed = !revealed;
      rows = (await api.get(`/bots/${bot.id}/env?reveal=${revealed ? 1 : 0}`)).env;
      draw();
    };

    $('#env-save').onclick = async () => {
      const payload = rows
        .filter((row) => row.key.trim())
        .map((row) => ({
          key: row.key.trim(),
          value: row.masked ? null : row.value,
          isSecret: row.isSecret,
        }));
      try {
        await api.put(`/bots/${bot.id}/env`, { env: payload });
        toast('Environment saved', 'ok');
        rows = (await api.get(`/bots/${bot.id}/env?reveal=${revealed ? 1 : 0}`)).env;
        draw();
      } catch (err) {
        toastError(err);
      }
    };

    $('#env-import').onclick = () => importEnvDialog();
  };

  const importEnvDialog = () => modal({
    title: 'Import from .env',
    render: `<label class="field"><span>Paste the contents of a .env file</span>
      <textarea id="env-paste" rows="10" placeholder="DISCORD_TOKEN=abc123&#10;CLIENT_ID=456"></textarea></label>
      <p class="hint muted">Existing keys are updated; everything else is added.</p>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Import',
        className: 'btn-primary',
        onClick: (modalBody, close) => {
          const text = $('#env-paste', modalBody).value;
          let added = 0;
          for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq === -1) continue;

            const key = line.slice(0, eq).trim();
            let value = line.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }

            const existing = rows.find((row) => row.key === key);
            if (existing) {
              existing.value = value;
              existing.masked = false;
            } else {
              rows.push({ key, value, isSecret: /(TOKEN|SECRET|PASSWORD|KEY|WEBHOOK|AUTH)/i.test(key), masked: false });
            }
            added++;
          }
          toast(`${added} variable${added === 1 ? '' : 's'} imported — remember to save`, 'ok');
          drawRows();
          close(true);
          return false;
        },
      },
    ],
  });

  draw();
}

/* -------------------------------------------------------------------- Git -- */

async function tabGit(body, bot, detail) {
  body.innerHTML = `<p class="muted">Loading…</p>`;

  const [gitInfo, deploys] = await Promise.all([
    api.get(`/bots/${bot.id}/git`).catch(() => ({ status: { repo: false }, commits: [] })),
    api.get(`/bots/${bot.id}/deploys`).catch(() => ({ deploys: [] })),
  ]);

  const status = gitInfo.status;
  const webhookUrl = detail.webhookUrl;

  body.innerHTML = `
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <h2>Repository</h2>
          <div class="row">
            ${status.repo && isAdmin() ? `<button class="btn btn-sm" id="git-branch">${icon('branch')}Switch branch</button>` : ''}
            <button class="btn btn-sm btn-primary" id="git-deploy">${icon('rocket')}Deploy now</button>
          </div>
        </div>
        <div class="card-body">
          ${status.repo ? `
            <div class="row wrap" style="gap:22px">
              <div><div class="muted" style="font-size:11.5px">Branch</div><div class="mono">${esc(status.branch)}</div></div>
              <div><div class="muted" style="font-size:11.5px">Remote</div><div class="mono truncate" style="max-width:340px">${esc(status.remote || '—')}</div></div>
              <div><div class="muted" style="font-size:11.5px">Working tree</div>
                <div>${status.dirty ? `<span class="badge st-backoff"><i class="dot"></i>${status.dirtyFiles.length} local change${status.dirtyFiles.length === 1 ? '' : 's'}</span>` : `<span class="badge st-running"><i class="dot"></i>Clean</span>`}</div>
              </div>
            </div>
            ${status.head ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
              <div class="muted" style="font-size:11.5px">Currently deployed</div>
              <div class="row" style="margin-top:5px"><span class="sha mono">${esc(status.head.shortSha)}</span>
                <span>${esc(status.head.subject)}</span>
                <span class="muted">· ${esc(status.head.author)}, ${esc(fmtAgo(Date.parse(status.head.date)))}</span></div>
            </div>` : ''}
          ` : `<p class="muted">No git repository. Add a repository URL in <a href="#/bot/${esc(bot.id)}/settings" style="color:var(--accent-2)">settings</a>, then deploy — or just manage the files directly.</p>`}
        </div>
      </div>

      <div class="card" id="deploy-live" hidden>
        <div class="card-head"><h2>Deploy in progress</h2><span class="badge st-starting"><i class="dot"></i>Running</span></div>
        <div class="card-body"><div class="deploy-log" id="deploy-out"></div></div>
      </div>

      ${status.repo ? `<div class="card">
        <div class="card-head"><h2>Recent commits</h2></div>
        <div class="card-body tight">
          ${gitInfo.commits.length > 0
            ? gitInfo.commits.map((commit) => `<div class="commit">
                <span class="sha">${esc(commit.shortSha)}</span>
                <span class="msg">${esc(commit.subject)}</span>
                <span class="muted nowrap" style="font-size:12px">${esc(commit.author)} · ${esc(fmtAgo(Date.parse(commit.date)))}</span>
                ${isAdmin() ? `<button class="btn btn-sm btn-ghost" data-checkout="${esc(commit.sha)}" title="Check out this commit">${icon('branch')}</button>` : ''}
              </div>`).join('')
            : '<p class="muted" style="padding:14px">No commits found.</p>'}
        </div>
      </div>` : ''}

      <div class="card">
        <div class="card-head"><h2>Deploy history</h2></div>
        <div class="card-body tight" id="deploy-history"></div>
      </div>

      ${!isAdmin() ? '' : `
      <div class="card">
        <div class="card-head"><h2>Auto-deploy webhook</h2>
          <button class="btn btn-sm" id="hook-rotate">${icon('refresh')}Rotate URL</button>
        </div>
        <div class="card-body">
          <p class="muted" style="font-size:12.5px;margin-bottom:10px">
            Add this as a GitHub webhook (content type <code class="mono">application/json</code>, push events).
            Every push to <code class="mono">${esc(bot.gitBranch)}</code> redeploys this bot.
          </p>
          <div class="row">
            <input class="mono" id="hook-url" readonly value="${esc(webhookUrl)}" />
            <button class="btn btn-sm" id="hook-copy">${icon('copy')}Copy</button>
          </div>
          <p class="hint muted" style="margin-top:8px">Anyone with this URL can trigger a deploy. Treat it like a password.</p>
        </div>
      </div>`}
    </div>`;

  drawDeployHistory(bot, deploys.deploys);
  wireDeployHistory(bot);

  $('#git-deploy').onclick = () => deployDialog(bot);

  if (isAdmin()) {
  $('#hook-copy').onclick = () => copyToClipboard(webhookUrl, 'Webhook URL copied');
  $('#hook-rotate').onclick = async () => {
    const ok = await confirmDialog({
      title: 'Rotate webhook URL?',
      message: 'The old URL stops working immediately. You will need to update it in GitHub.',
      confirmLabel: 'Rotate',
      danger: true,
    });
    if (!ok) return;
    const result = await api.post(`/bots/${bot.id}/webhook/rotate`);
    $('#hook-url').value = result.webhookUrl;
    toast('Webhook URL rotated', 'ok');
  };
  }

  if ($('#git-branch')) {
    $('#git-branch').onclick = async () => {
      const { branches } = await api.get(`/bots/${bot.id}/git/branches`);
      const chosen = await modal({
        title: 'Switch branch',
        render: `<label class="field"><span>Branch</span>
          <select id="branch-pick">${branches.map((branch) => `<option ${branch === status.branch ? 'selected' : ''}>${esc(branch)}</option>`).join('')}</select></label>
          <p class="hint muted">Switching checks the branch out and updates the tracked branch for future deploys.</p>`,
        actions: [
          { label: 'Cancel', value: null },
          {
            label: 'Switch',
            className: 'btn-primary',
            onClick: (modalBody, close) => {
              close($('#branch-pick', modalBody).value);
              return false;
            },
          },
        ],
      });
      if (!chosen) return;
      try {
        await api.post(`/bots/${bot.id}/git/checkout`, { ref: chosen });
        toast(`Switched to ${chosen}`, 'ok');
        route();
      } catch (err) {
        toastError(err);
      }
    };
  }

  on(body, 'click', '[data-checkout]', async (_ev, button) => {
    const sha = button.dataset.checkout;
    const ok = await confirmDialog({
      title: 'Check out this commit?',
      message: `The working tree moves to ${sha.slice(0, 8)}. Deploy afterwards to reinstall dependencies.`,
      confirmLabel: 'Check out',
    });
    if (!ok) return;
    try {
      await api.post(`/bots/${bot.id}/git/checkout`, { ref: sha });
      toast('Checked out', 'ok');
      route();
    } catch (err) {
      toastError(err);
    }
  });

  // Live deploy output.
  const channel = `deploy:${bot.id}`;
  live.subscribe([channel]);
  const off = live.on(channel, (message) => {
    const card = $('#deploy-live');
    const out = $('#deploy-out');
    if (!card || !out) return;
    card.hidden = false;
    out.insertAdjacentHTML('beforeend', `<div class="dl ${esc(message.data.level)}">${esc(message.data.text)}</div>`);
    out.scrollTop = out.scrollHeight;
  });
  cleanup(() => {
    off();
    live.unsubscribe([channel]);
  });

  const onDeployEnd = async (ev) => {
    if (ev.detail?.type !== 'deploy-end') return;
    const fresh = await api.get(`/bots/${bot.id}/deploys`);
    drawDeployHistory(bot, fresh.deploys);
  };
  window.addEventListener('bots:changed', onDeployEnd);
  cleanup(() => window.removeEventListener('bots:changed', onDeployEnd));
}

function drawDeployHistory(bot, deploys) {
  const host = $('#deploy-history');
  if (!host) return;

  if (deploys.length === 0) {
    host.innerHTML = `<p class="muted" style="padding:14px">No deploys yet.</p>`;
    return;
  }

  const badgeFor = (status) => ({
    success: 'st-running',
    failed: 'st-crashed',
    running: 'st-starting',
  }[status] ?? 'st-stopped');

  host.innerHTML = deploys.map((deployRecord) => `
    <div class="list-row">
      <span class="badge ${badgeFor(deployRecord.status)}"><i class="dot"></i>${esc(deployRecord.status)}</span>
      <div class="grow">
        <div class="truncate">${esc(deployRecord.commit_msg || 'No commit information')}</div>
        <div class="muted" style="font-size:11.5px">
          ${esc(deployRecord.trigger_type)} · ${esc(fmtDateTime(deployRecord.started_at))}
          ${deployRecord.finished_at ? ` · took ${fmtDuration(deployRecord.finished_at - deployRecord.started_at)}` : ''}
        </div>
      </div>
      ${deployRecord.commit_sha ? `<span class="sha mono">${esc(deployRecord.commit_sha.slice(0, 7))}</span>` : ''}
      <button class="btn btn-sm btn-ghost" data-deploy-log="${esc(deployRecord.id)}">Log</button>
    </div>`).join('');
}

/** Bound once by tabGit; drawDeployHistory only replaces the rows. */
function wireDeployHistory(bot) {
  on($('#deploy-history'), 'click', '[data-deploy-log]', async (_ev, button) => {
    const record = await api.get(`/bots/${bot.id}/deploys/${button.dataset.deployLog}`);
    modal({
      title: `Deploy log · ${record.deploy.status}`,
      wide: true,
      render: `<div class="deploy-log" style="max-height:60vh">${
        (record.deploy.log || 'No output recorded.')
          .split('\n')
          .map((line) => `<div class="dl">${esc(line)}</div>`)
          .join('')
      }</div>`,
      actions: [{ label: 'Close' }],
    });
  });
}

function deployDialog(bot) {
  return modal({
    title: `Deploy ${bot.name}`,
    render: `
      <p class="muted" style="font-size:13px;line-height:1.6">
        Pulls the latest ${bot.gitUrl ? `code from <code class="mono">${esc(bot.gitBranch)}</code>` : 'files on disk'},
        installs dependencies, then restarts the bot.
      </p>
      <label class="switch"><input type="checkbox" id="dp-install" checked /><span class="track"></span><span>Install dependencies</span></label>
      <label class="switch"><input type="checkbox" id="dp-restart" checked /><span class="track"></span><span>Restart when finished</span></label>
      <label class="switch"><input type="checkbox" id="dp-force" /><span class="track"></span><span>Force sync — discard local changes</span></label>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Deploy',
        className: 'btn-primary',
        icon: 'rocket',
        onClick: async (body, close) => {
          try {
            await api.post(`/bots/${bot.id}/deploy`, {
              skipInstall: !$('#dp-install', body).checked,
              restart: $('#dp-restart', body).checked,
              force: $('#dp-force', body).checked,
            });
            toast('Deploy started — watch the Git tab for output', 'ok');
            close(true);
            if (!location.hash.includes('/git')) location.hash = `#/bot/${bot.id}/git`;
          } catch (err) {
            toastError(err);
          }
          return false;
        },
      },
    ],
  });
}

/* ---------------------------------------------------------------- Metrics -- */

async function tabMetrics(body, bot) {
  body.innerHTML = `<p class="muted">Loading…</p>`;

  const load = async (hours) => {
    const data = await api.get(`/bots/${bot.id}/metrics?hours=${hours}`);
    const snapshot = state.states[bot.id] ?? {};
    const color = accentHex(bot.accent);

    // Live samples are finer-grained; stored ones go further back.
    const cpuPoints = [...data.stored, ...data.live].map((point) => ({ ts: point.ts, value: point.cpu }));
    const memPoints = [...data.stored, ...data.live].map((point) => ({ ts: point.ts, value: point.mem }));

    body.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="t-label">${icon('cpu')}CPU now</div><div class="t-value">${(snapshot.cpu ?? 0).toFixed(1)}<small>%</small></div><div class="t-sub">of one core</div></div>
        <div class="tile"><div class="t-label">${icon('memory')}Memory now</div><div class="t-value">${fmtBytes(snapshot.mem ?? 0)}</div><div class="t-sub">resident, whole process tree</div></div>
        <div class="tile"><div class="t-label">${icon('clock')}Uptime</div><div class="t-value" style="font-size:20px">${snapshot.status === 'running' ? fmtDuration(snapshot.uptime) : '—'}</div><div class="t-sub">${esc(statusLabel(snapshot.status ?? 'stopped'))}</div></div>
        <div class="tile"><div class="t-label">${icon('restart')}Restarts</div><div class="t-value">${snapshot.restarts ?? 0}</div><div class="t-sub">since the panel started</div></div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><h2>CPU</h2>
            <select id="mt-range" style="width:auto">
              <option value="1" ${hours === 1 ? 'selected' : ''}>Last hour</option>
              <option value="6" ${hours === 6 ? 'selected' : ''}>Last 6 hours</option>
              <option value="24" ${hours === 24 ? 'selected' : ''}>Last 24 hours</option>
              <option value="168" ${hours === 168 ? 'selected' : ''}>Last week</option>
            </select>
          </div>
          <div class="card-body">${areaChart(cpuPoints, { color, format: (v) => `${v.toFixed(0)}%`, label: 'CPU over time' })}</div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Memory</h2></div>
          <div class="card-body">${areaChart(memPoints, { color: '#38bdf8', format: fmtBytes, label: 'Memory over time' })}</div>
        </div>
      </div>`;

    $('#mt-range').onchange = (ev) => load(Number(ev.target.value));
  };

  await load(6).catch(toastError);

  // Refresh periodically so the charts stay current without a manual reload.
  const timer = setInterval(() => {
    if (document.hidden) return;
    const range = Number($('#mt-range')?.value ?? 6);
    load(range).catch(() => {});
  }, 30_000);
  cleanup(() => clearInterval(timer));
}

/* --------------------------------------------------------- Bot settings --- */

function tabSettings(body, bot) {
  const runtimeOptions = state.runtimes
    .map((runtime) => `<option value="${esc(runtime.id)}" ${runtime.id === bot.runtime ? 'selected' : ''}>${esc(runtime.label)}</option>`)
    .join('');

  const accentSwatches = state.accents
    .map((accent) => `<button type="button" class="icon-btn" data-accent="${esc(accent)}" title="${esc(accent)}"
        style="background:${accentHex(accent)};width:22px;height:22px;border-radius:7px;${accent === bot.accent ? 'outline:2px solid var(--text);outline-offset:2px' : ''}"></button>`)
    .join('');

  body.innerHTML = `
    <div class="stack view-narrow">
      <div class="card">
        <div class="card-head"><h2>General</h2></div>
        <div class="card-body stack">
          <div class="grid-2">
            <label class="field"><span>Name</span><input id="s-name" value="${esc(bot.name)}" /></label>
            <label class="field"><span>Runtime</span><select id="s-runtime">${runtimeOptions}</select></label>
          </div>
          <label class="field"><span>Description</span><input id="s-desc" value="${esc(bot.description ?? '')}" placeholder="What this bot does" /></label>
          <div class="field"><span>Accent colour</span><div class="row" id="s-accents">${accentSwatches}</div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Commands</h2></div>
        <div class="card-body stack">
          <label class="field"><span>Start command</span>
            <input class="mono" id="s-start" value="${esc(bot.startCmd ?? '')}" placeholder="node index.js" />
            <span class="hint">Runs in the bot's directory through a login shell, so nvm and pyenv paths work.</span>
          </label>
          <label class="field"><span>Install command</span>
            <input class="mono" id="s-install" value="${esc(bot.installCmd ?? '')}" placeholder="npm install --omit=dev" />
            <span class="hint">Runs on every deploy before the bot restarts. Leave empty to skip.</span>
          </label>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Git</h2></div>
        <div class="card-body stack">
          <label class="field"><span>Repository URL</span>
            <input class="mono" id="s-giturl" value="${esc(bot.gitUrl ?? '')}" placeholder="https://github.com/you/your-bot.git" /></label>
          <div class="grid-2">
            <label class="field"><span>Branch</span><input class="mono" id="s-branch" value="${esc(bot.gitBranch ?? 'main')}" /></label>
            <label class="field"><span>Access token <em class="muted">private repos</em></span>
              <input type="password" id="s-token" placeholder="${bot.hasGitToken ? '•••••••• saved' : 'ghp_…'}" autocomplete="off" />
              <span class="hint">${bot.hasGitToken ? 'Leave blank to keep the saved token.' : 'Stored on this host only, never sent to the browser.'}</span>
            </label>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Process behaviour</h2></div>
        <div class="card-body stack">
          <label class="switch"><input type="checkbox" id="s-autostart" ${bot.autostart ? 'checked' : ''} /><span class="track"></span><span>Start automatically when the panel boots</span></label>
          <label class="switch"><input type="checkbox" id="s-envfile" ${bot.writeEnvFile ? 'checked' : ''} /><span class="track"></span><span>Write variables to a <code class="mono">.env</code> file</span></label>
          <div class="grid-2">
            <label class="field"><span>Restart policy</span>
              <select id="s-policy">
                <option value="on-failure" ${bot.restartPolicy === 'on-failure' ? 'selected' : ''}>On failure — restart unless it exits cleanly</option>
                <option value="always" ${bot.restartPolicy === 'always' ? 'selected' : ''}>Always — restart on any exit</option>
                <option value="never" ${bot.restartPolicy === 'never' ? 'selected' : ''}>Never — leave it stopped</option>
              </select>
            </label>
            <label class="field"><span>Restart limit</span>
              <input type="number" id="s-max" value="${Number(bot.maxRestarts)}" min="1" max="100" />
              <span class="hint">Consecutive failures before the panel gives up.</span>
            </label>
          </div>
          <label class="field" style="max-width:260px"><span>Initial restart delay (ms)</span>
            <input type="number" id="s-delay" value="${Number(bot.restartDelay)}" min="500" step="500" />
            <span class="hint">Doubles with each failure, capped at 60 seconds.</span>
          </label>
        </div>
      </div>

      <div class="row-between">
        <span class="muted" style="font-size:12.5px">Created ${esc(fmtAgo(bot.createdAt))} · updated ${esc(fmtAgo(bot.updatedAt))}</span>
        <button class="btn btn-primary" id="s-save">${icon('save')}Save changes</button>
      </div>

      <div class="card">
        <div class="card-head"><h2>Backups</h2>
          <button class="btn btn-sm" id="s-backup">${icon('save')}Create backup</button>
        </div>
        <div class="card-body tight" id="s-backups"></div>
      </div>

      <div class="card" style="border-color:rgba(248,113,113,.28)">
        <div class="card-head"><h2 style="color:var(--bad)">Danger zone</h2></div>
        <div class="card-body row-between">
          <div>
            <div>Delete this bot</div>
            <div class="muted" style="font-size:12.5px">Stops the process and removes its files, logs and settings.</div>
          </div>
          <button class="btn btn-bad" id="s-delete">${icon('trash')}Delete</button>
        </div>
      </div>
    </div>`;

  let accent = bot.accent;
  on($('#s-accents'), 'click', '[data-accent]', (_ev, button) => {
    accent = button.dataset.accent;
    for (const swatch of $$('#s-accents [data-accent]')) {
      swatch.style.outline = swatch.dataset.accent === accent ? '2px solid var(--text)' : '';
      swatch.style.outlineOffset = '2px';
    }
  });

  $('#s-save').onclick = async (ev) => {
    const button = ev.currentTarget;
    button.disabled = true;
    const patch = {
      name: $('#s-name').value.trim(),
      description: $('#s-desc').value.trim(),
      accent,
      runtime: $('#s-runtime').value,
      startCmd: $('#s-start').value.trim(),
      installCmd: $('#s-install').value.trim(),
      gitUrl: $('#s-giturl').value.trim(),
      gitBranch: $('#s-branch').value.trim() || 'main',
      autostart: $('#s-autostart').checked,
      writeEnvFile: $('#s-envfile').checked,
      restartPolicy: $('#s-policy').value,
      maxRestarts: Number($('#s-max').value),
      restartDelay: Number($('#s-delay').value),
    };
    const token = $('#s-token').value.trim();
    if (token) patch.gitToken = token;

    try {
      await api.patch(`/bots/${bot.id}`, patch);
      await refreshBots();
      toast('Settings saved', 'ok');
      route();
    } catch (err) {
      toastError(err);
    } finally {
      button.disabled = false;
    }
  };

  $('#s-delete').onclick = () => botAction(bot.id, 'delete');

  const loadBackups = async () => {
    const { backups } = await api.get(`/bots/${bot.id}/backups`);
    const host = $('#s-backups');
    host.innerHTML = backups.length === 0
      ? `<p class="muted" style="padding:14px">No backups yet. A backup archives the bot's files, skipping <code class="mono">node_modules</code>, <code class="mono">.venv</code> and <code class="mono">.git</code>.</p>`
      : backups.map((backup) => `<div class="list-row">
          ${icon('save')}
          <div class="grow"><div class="mono" style="font-size:12.5px">${esc(backup.name)}</div>
          <div class="muted" style="font-size:11.5px">${esc(fmtBytes(backup.size))} · ${esc(fmtAgo(backup.createdAt))}</div></div>
          <a class="icon-btn" href="/api/bots/${esc(bot.id)}/backups/${esc(backup.name)}" title="Download">${icon('download')}</a>
          <button class="icon-btn danger" data-rmbackup="${esc(backup.name)}" title="Delete">${icon('trash')}</button>
        </div>`).join('');
  };

  // Bound once — loadBackups reruns after every create and delete.
  on($('#s-backups'), 'click', '[data-rmbackup]', async (_ev, button) => {
    await api.del(`/bots/${bot.id}/backups/${button.dataset.rmbackup}`);
    loadBackups();
  });

  $('#s-backup').onclick = async (ev) => {
    const button = ev.currentTarget;
    button.disabled = true;
    button.textContent = 'Archiving…';
    try {
      await api.post(`/bots/${bot.id}/backups`);
      toast('Backup created', 'ok');
      loadBackups();
    } catch (err) {
      toastError(err);
    } finally {
      button.disabled = false;
      button.innerHTML = `${icon('save')}Create backup`;
    }
  };

  loadBackups().catch(toastError);
}

/* ==========================================================================
   New bot
   ========================================================================== */

function newBotDialog() {
  return modal({
    title: 'Add a bot',
    wide: true,
    render: `
      <div class="grid-2">
        <label class="field"><span>Name</span><input id="nb-name" placeholder="Moderation Bot" /></label>
        <label class="field"><span>Runtime</span>
          <select id="nb-runtime">
            <option value="node">Node.js</option>
            <option value="python">Python</option>
            <option value="custom">Custom</option>
          </select>
        </label>
      </div>
      <label class="field"><span>Repository URL <em class="muted">optional</em></span>
        <input class="mono" id="nb-git" placeholder="https://github.com/you/your-bot.git" />
        <span class="hint">Leave empty to start with an empty folder and upload files yourself.</span>
      </label>
      <div class="grid-2">
        <label class="field"><span>Branch</span><input class="mono" id="nb-branch" value="main" /></label>
        <label class="field"><span>Access token <em class="muted">private repos</em></span>
          <input type="password" id="nb-token" placeholder="ghp_…" autocomplete="off" /></label>
      </div>
      <label class="field"><span>Environment <em class="muted">paste your .env — optional</em></span>
        <textarea id="nb-env" rows="4" placeholder="DISCORD_TOKEN=…"></textarea>
      </label>
      <label class="switch"><input type="checkbox" id="nb-autostart" checked /><span class="track"></span><span>Start automatically when the panel boots</span></label>
      <p class="hint muted">Commands are detected from the repository after cloning — you can change them in settings.</p>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Create bot',
        className: 'btn-primary',
        icon: 'plus',
        onClick: async (body, close, button) => {
          const name = $('#nb-name', body).value.trim();
          if (!name) {
            toast('Give the bot a name', 'bad');
            return false;
          }

          const env = [];
          for (const rawLine of $('#nb-env', body).value.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq === -1) continue;
            let value = line.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            env.push({ key: line.slice(0, eq).trim(), value });
          }

          button.disabled = true;
          try {
            const { bot } = await api.post('/bots', {
              name,
              runtime: $('#nb-runtime', body).value,
              gitUrl: $('#nb-git', body).value.trim() || undefined,
              gitBranch: $('#nb-branch', body).value.trim() || 'main',
              gitToken: $('#nb-token', body).value.trim() || undefined,
              autostart: $('#nb-autostart', body).checked,
              env,
            });
            await refreshBots();
            close(true);
            toast(bot.gitUrl ? `${bot.name} created — cloning now` : `${bot.name} created`, 'ok');
            location.hash = bot.gitUrl ? `#/bot/${bot.id}/git` : `#/bot/${bot.id}/settings`;
          } catch (err) {
            toastError(err);
            button.disabled = false;
          }
          return false;
        },
      },
    ],
  });
}

/* ==========================================================================
   Activity
   ========================================================================== */

async function renderActivity(view) {
  setNav('activity');
  setCrumbs([{ label: 'Activity' }]);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Activity</h1><p class="sub">Everything the panel and your bots have done</p></div>
      <button class="btn" id="act-refresh">${icon('refresh')}Refresh</button>
    </div>
    <div class="card"><div class="card-body tight" id="act-list"><p class="muted" style="padding:16px">Loading…</p></div></div>`;

  const load = async () => {
    const { events } = await api.get('/events?limit=200');
    const host = $('#act-list');

    if (events.length === 0) {
      host.innerHTML = `<p class="muted" style="padding:16px">Nothing here yet.</p>`;
      return;
    }

    const toneFor = (type) => {
      if (type.includes('crash') || type.includes('failed') || type.includes('delete')) return 'var(--bad)';
      if (type.includes('start') || type.includes('success')) return 'var(--ok)';
      if (type.includes('stop') || type.includes('kill')) return 'var(--warn)';
      return 'var(--accent-2)';
    };

    host.innerHTML = events.map((event) => {
      const bot = byId(event.bot_id);
      return `<div class="list-row">
        <i style="width:7px;height:7px;border-radius:99px;background:${toneFor(event.type)};flex:none"></i>
        <div class="grow">
          <div class="truncate">${esc(event.message)}</div>
          <div class="muted" style="font-size:11.5px">
            <span class="mono">${esc(event.type)}</span>
            ${bot ? ` · <a href="#/bot/${esc(bot.id)}" style="color:var(--accent-2)">${esc(bot.name)}</a>` : ''}
          </div>
        </div>
        <span class="muted nowrap" style="font-size:12px" title="${esc(new Date(event.created_at).toLocaleString())}">${esc(fmtAgo(event.created_at))}</span>
      </div>`;
    }).join('');
  };

  $('#act-refresh').onclick = () => load();
  await load().catch(toastError);
}

/* ==========================================================================
   Panel settings
   ========================================================================== */

async function renderSettings(view) {
  setNav('settings');
  setCrumbs([{ label: 'Settings' }]);

  const [system, sessionData] = await Promise.all([
    api.get('/system').catch(() => null),
    api.get('/auth/sessions').catch(() => ({ sessions: [] })),
  ]);

  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p class="sub">Your account and this host</p></div></div>

    <div class="stack view-narrow">
      <div class="card">
        <div class="card-head"><h2>Account</h2></div>
        <div class="card-body stack">
          <div class="row-between">
            <div>
              <div style="font-weight:600">${esc(state.user.username)}</div>
              <div class="muted" style="font-size:12.5px">${esc(state.user.email || 'No email set')} · ${esc(state.user.role)}</div>
            </div>
            <button class="btn" id="set-password">${icon('key')}Change password</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Active sessions</h2></div>
        <div class="card-body tight">
          ${sessionData.sessions.map((session) => `<div class="list-row">
            ${icon('link')}
            <div class="grow">
              <div>${esc(session.ip ?? 'unknown address')} ${session.current ? '<span class="badge st-running" style="margin-left:6px"><i class="dot"></i>This device</span>' : ''}</div>
              <div class="muted truncate" style="font-size:11.5px">${esc(session.userAgent ?? '')}</div>
            </div>
            <span class="muted nowrap" style="font-size:12px">since ${esc(fmtAgo(session.createdAt))}</span>
          </div>`).join('') || '<p class="muted" style="padding:14px">No sessions.</p>'}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Host</h2></div>
        <div class="card-body">
          ${system ? `<table class="table">
            <tbody>
              <tr><td class="muted">Version</td><td class="mono">${esc(system.version)}</td></tr>
              <tr><td class="muted">Hostname</td><td class="mono">${esc(system.host.hostname)}</td></tr>
              <tr><td class="muted">Platform</td><td class="mono">${esc(system.host.platform)} · ${esc(system.host.arch)}</td></tr>
              <tr><td class="muted">Node</td><td class="mono">${esc(system.host.nodeVersion)}</td></tr>
              <tr><td class="muted">CPU cores</td><td class="mono">${esc(system.host.cores)}</td></tr>
              <tr><td class="muted">Memory</td><td class="mono">${esc(fmtBytes(system.host.memUsed))} / ${esc(fmtBytes(system.host.memTotal))}</td></tr>
              <tr><td class="muted">Disk</td><td class="mono">${esc(fmtBytes(system.host.disk.used))} / ${esc(fmtBytes(system.host.disk.total))}</td></tr>
              <tr><td class="muted">Host uptime</td><td class="mono">${esc(fmtDuration(system.host.uptime * 1000))}</td></tr>
              <tr><td class="muted">Panel uptime</td><td class="mono">${esc(fmtDuration(system.host.panelUptime * 1000))} · ${esc(fmtBytes(system.host.panelMem))} RSS</td></tr>
              <tr><td class="muted">Bots</td><td class="mono">${esc(system.counts.running)} running of ${esc(system.counts.bots)}</td></tr>
              <tr><td class="muted">Live connections</td><td class="mono">${esc(system.counts.connectedClients)}</td></tr>
            </tbody>
          </table>` : '<p class="muted">Could not read host information.</p>'}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Keyboard shortcuts</h2></div>
        <div class="card-body">
          <table class="table"><tbody>
            <tr><td><kbd>Ctrl</kbd> <kbd>K</kbd></td><td class="muted">Command palette</td></tr>
            <tr><td><kbd>N</kbd></td><td class="muted">New bot</td></tr>
            <tr><td><kbd>/</kbd></td><td class="muted">Search bots</td></tr>
            <tr><td><kbd>G</kbd> then <kbd>H</kbd></td><td class="muted">Go to overview</td></tr>
            <tr><td><kbd>Esc</kbd></td><td class="muted">Close a dialog</td></tr>
          </tbody></table>
        </div>
      </div>
    </div>`;

  $('#set-password').onclick = () => modal({
    title: 'Change password',
    render: `
      <label class="field"><span>Current password</span><input type="password" id="pw-old" autocomplete="current-password" /></label>
      <label class="field"><span>New password</span><input type="password" id="pw-new" autocomplete="new-password" />
        <span class="hint">At least 8 characters.</span></label>
      <p class="hint muted">Changing your password signs you out everywhere, including this tab.</p>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Change password',
        className: 'btn-primary',
        onClick: async (body) => {
          try {
            await api.post('/auth/password', {
              currentPassword: $('#pw-old', body).value,
              newPassword: $('#pw-new', body).value,
            });
            toast('Password changed — signing you out', 'ok');
            setTimeout(() => location.reload(), 1200);
          } catch (err) {
            toastError(err);
          }
          return false;
        },
      },
    ],
  });
}

/* ==========================================================================
   Administration
   ========================================================================== */

async function renderAdmin(view) {
  setNav('admin');
  setCrumbs([{ label: 'Administration' }]);

  if (!isAdmin()) {
    view.innerHTML = `<div class="empty">${icon('alert')}<h2>Administrators only</h2>
      <p>Your account does not have access to instance settings.</p>
      <a class="btn" href="#/">Back to overview</a></div>`;
    return;
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Administration</h1><p class="sub">Branding, access and defaults for this instance</p></div>
    </div>
    <div class="stack view-narrow" id="admin-body"><p class="muted">Loading…</p></div>`;

  const [{ settings: current }, { users, roles }] = await Promise.all([
    api.get('/settings'),
    api.get('/users'),
  ]);

  $('#admin-body').innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Appearance</h2></div>
      <div class="card-body stack">
        <label class="field"><span>Instance name</span>
          <input id="ad-name" value="${esc(current.instanceName)}" maxlength="40" />
          <span class="hint">Shown in the sidebar, the browser tab and on the sign-in screen.</span>
        </label>
        <div class="field"><span>Accent colour</span>
          <div class="row" id="ad-accents">
            ${state.accents.map((accent) => `<button type="button" class="swatch" data-accent="${esc(accent)}"
                aria-pressed="${accent === current.instanceAccent}" title="${esc(accent)}"
                style="background:${accentHex(accent)}"></button>`).join('')}
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Access</h2></div>
      <div class="card-body stack">
        <label class="switch"><input type="checkbox" id="ad-register" ${current.allowRegistration ? 'checked' : ''} />
          <span class="track"></span><span>Allow anyone to create an account</span></label>
        <p class="hint muted">Self-registered accounts get the operator role: they can start, stop and deploy bots, but cannot change configuration.</p>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Networking</h2></div>
      <div class="card-body stack">
        <label class="field"><span>Public URL</span>
          <input class="mono" id="ad-url" value="${esc(current.publicUrl)}" placeholder="https://bots.example.com" />
          <span class="hint">Used to build webhook URLs. Set this when the panel runs behind a reverse proxy or a domain; leave empty to use the address you are browsing from.</span>
        </label>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Defaults</h2></div>
      <div class="card-body stack">
        <div class="grid-2">
          <label class="field"><span>Restart policy for new bots</span>
            <select id="ad-policy">
              <option value="on-failure" ${current.defaultRestartPolicy === 'on-failure' ? 'selected' : ''}>On failure</option>
              <option value="always" ${current.defaultRestartPolicy === 'always' ? 'selected' : ''}>Always</option>
              <option value="never" ${current.defaultRestartPolicy === 'never' ? 'selected' : ''}>Never</option>
            </select>
          </label>
          <label class="field"><span>Keep activity history for</span>
            <input type="number" id="ad-retention" min="1" max="365" value="${Number(current.logRetentionDays)}" />
            <span class="hint">Days.</span>
          </label>
        </div>
      </div>
    </div>

    <div class="row-between">
      <span class="muted" style="font-size:12.5px">Changes apply immediately for everyone.</span>
      <button class="btn btn-primary" id="ad-save">${icon('save')}Save settings</button>
    </div>

    <div class="card">
      <div class="card-head"><h2>Users</h2>
        <button class="btn btn-sm" id="ad-newuser">${icon('plus')}Add user</button>
      </div>
      <div class="card-body tight" id="ad-users"></div>
    </div>`;

  let accent = current.instanceAccent;
  on($('#ad-accents'), 'click', '[data-accent]', (_ev, button) => {
    accent = button.dataset.accent;
    for (const swatch of $$('#ad-accents .swatch')) {
      swatch.setAttribute('aria-pressed', String(swatch.dataset.accent === accent));
    }
    applyAccent(accent); // preview before saving
  });

  $('#ad-save').onclick = async (ev) => {
    const button = ev.currentTarget;
    button.disabled = true;
    try {
      const { settings: saved } = await api.patch('/settings', {
        instanceName: $('#ad-name').value.trim() || 'BotPanel',
        instanceAccent: accent,
        publicUrl: $('#ad-url').value.trim(),
        allowRegistration: $('#ad-register').checked,
        defaultRestartPolicy: $('#ad-policy').value,
        logRetentionDays: Number($('#ad-retention').value),
      });
      applyInstance({ ...saved, version: state.instance.version });
      toast('Settings saved', 'ok');
    } catch (err) {
      toastError(err);
    } finally {
      button.disabled = false;
    }
  };

  const drawUsers = (list) => {
    $('#ad-users').innerHTML = list.map((user) => `
      <div class="list-row">
        ${icon('bot')}
        <div class="grow">
          <div>${esc(user.username)} <span class="role-pill ${user.role === 'admin' ? 'admin' : ''}">${esc(user.role)}</span></div>
          <div class="muted" style="font-size:11.5px">
            ${esc(user.email || 'No email')} · joined ${esc(fmtAgo(user.createdAt))} ·
            last seen ${esc(fmtAgo(user.lastLoginAt))}
          </div>
        </div>
        <button class="icon-btn" data-edituser="${esc(user.id)}" title="Edit user">${icon('settings')}</button>
        ${user.id === state.user.id
          ? ''
          : `<button class="icon-btn danger" data-deluser="${esc(user.id)}" title="Delete user">${icon('trash')}</button>`}
      </div>`).join('');
  };

  drawUsers(users);

  const reloadUsers = async () => drawUsers((await api.get('/users')).users);

  on($('#ad-users'), 'click', '[data-deluser]', async (_ev, button) => {
    const target = users.find((user) => user.id === button.dataset.deluser);
    const ok = await confirmDialog({
      title: `Delete ${target?.username}?`,
      message: 'Their sessions end immediately. Bots they created are not affected.',
      confirmLabel: 'Delete user',
      danger: true,
    });
    if (!ok) return;

    try {
      await api.del(`/users/${button.dataset.deluser}`);
      await reloadUsers();
      toast('User deleted', 'ok');
    } catch (err) {
      toastError(err);
    }
  });

  on($('#ad-users'), 'click', '[data-edituser]', async (_ev, button) => {
    const target = (await api.get('/users')).users.find((user) => user.id === button.dataset.edituser);
    if (!target) return;

    await modal({
      title: `Edit ${target.username}`,
      render: `
        <label class="field"><span>Email</span><input id="eu-email" value="${esc(target.email ?? '')}" /></label>
        <label class="field"><span>Role</span>
          <select id="eu-role">
            ${roles.map((role) => `<option value="${esc(role)}" ${role === target.role ? 'selected' : ''}>${esc(role)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>New password <em class="muted">optional</em></span>
          <input type="password" id="eu-password" autocomplete="new-password" placeholder="Leave blank to keep it" />
          <span class="hint">Setting a password signs this user out everywhere.</span>
        </label>`,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save',
          className: 'btn-primary',
          onClick: async (body, close) => {
            const payload = {
              email: $('#eu-email', body).value.trim(),
              role: $('#eu-role', body).value,
            };
            const password = $('#eu-password', body).value;
            if (password) payload.password = password;

            try {
              await api.patch(`/users/${target.id}`, payload);
              await reloadUsers();
              toast('User updated', 'ok');
              close(true);
            } catch (err) {
              toastError(err);
            }
            return false;
          },
        },
      ],
    });
  });

  $('#ad-newuser').onclick = () => modal({
    title: 'Add user',
    render: `
      <div class="grid-2">
        <label class="field"><span>Username</span><input id="nu-name" autocomplete="off" /></label>
        <label class="field"><span>Role</span>
          <select id="nu-role">
            <option value="operator">operator — run and deploy bots</option>
            <option value="admin">admin — full access</option>
          </select>
        </label>
      </div>
      <label class="field"><span>Email <em class="muted">optional</em></span><input type="email" id="nu-email" /></label>
      <label class="field"><span>Password</span><input type="password" id="nu-password" autocomplete="new-password" />
        <span class="hint">At least 8 characters.</span></label>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Create user',
        className: 'btn-primary',
        onClick: async (body, close) => {
          try {
            await api.post('/users', {
              username: $('#nu-name', body).value.trim(),
              email: $('#nu-email', body).value.trim() || undefined,
              password: $('#nu-password', body).value,
              role: $('#nu-role', body).value,
            });
            await reloadUsers();
            toast('User created', 'ok');
            close(true);
          } catch (err) {
            toastError(err);
          }
          return false;
        },
      },
    ],
  });
}

/* ==========================================================================
   Command palette
   ========================================================================== */

function openPalette() {
  const palette = $('#palette');
  const input = $('#palette-q');
  const list = $('#palette-list');
  palette.hidden = false;
  input.value = '';
  input.focus();

  let selected = 0;

  const commands = () => [
    ...state.bots.flatMap((bot) => {
      const snapshot = state.states[bot.id] ?? {};
      return [{
        label: bot.name,
        hint: statusLabel(snapshot.status ?? 'stopped'),
        icon: 'bot',
        run: () => { location.hash = `#/bot/${bot.id}`; },
      }, {
        label: `${bot.name} — console`,
        hint: 'open',
        icon: 'terminal',
        run: () => { location.hash = `#/bot/${bot.id}/console`; },
      }, {
        label: `${bot.name} — ${snapshot.status === 'running' ? 'restart' : 'start'}`,
        hint: 'action',
        icon: snapshot.status === 'running' ? 'restart' : 'play',
        run: () => botAction(bot.id, snapshot.status === 'running' ? 'restart' : 'start'),
      }, {
        label: `${bot.name} — deploy`,
        hint: 'action',
        icon: 'rocket',
        run: () => botAction(bot.id, 'deploy'),
      }];
    }),
    ...(isAdmin() ? [
      { label: 'New bot', hint: 'N', icon: 'plus', run: () => newBotDialog() },
      { label: 'Administration', hint: 'go', icon: 'server', run: () => { location.hash = '#/admin'; } },
    ] : []),
    { label: 'Overview', hint: 'go', icon: 'grid', run: () => { location.hash = '#/'; } },
    { label: 'Activity', hint: 'go', icon: 'activity', run: () => { location.hash = '#/activity'; } },
    { label: 'Settings', hint: 'go', icon: 'settings', run: () => { location.hash = '#/settings'; } },
  ];

  const filtered = () => {
    const query = input.value.trim().toLowerCase();
    if (!query) return commands().slice(0, 12);
    return commands()
      .filter((command) => command.label.toLowerCase().includes(query))
      .slice(0, 12);
  };

  const draw = () => {
    const items = filtered();
    selected = Math.min(selected, Math.max(items.length - 1, 0));
    list.innerHTML = items.length === 0
      ? `<div class="palette-empty">Nothing matches “${esc(input.value)}”</div>`
      : items.map((item, index) => `<div class="palette-item ${index === selected ? 'sel' : ''}" data-i="${index}">
          ${icon(item.icon)}<span>${esc(item.label)}</span><span class="pi-hint">${esc(item.hint)}</span>
        </div>`).join('');
  };

  const close = () => {
    palette.hidden = true;
    input.onkeydown = null;
    input.oninput = null;
    document.removeEventListener('keydown', onKey);
  };

  const choose = (index) => {
    const item = filtered()[index];
    if (!item) return;
    close();
    item.run();
  };

  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  };

  input.oninput = () => {
    selected = 0;
    draw();
  };

  input.onkeydown = (ev) => {
    const items = filtered();
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      selected = (selected + 1) % Math.max(items.length, 1);
      draw();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      selected = (selected - 1 + items.length) % Math.max(items.length, 1);
      draw();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      choose(selected);
    }
  };

  list.onclick = (ev) => {
    const item = ev.target.closest('[data-i]');
    if (item) choose(Number(item.dataset.i));
  };

  palette.onclick = (ev) => {
    if (ev.target === palette) close();
  };

  document.addEventListener('keydown', onKey);
  draw();
}

/* ========================================================================== */

boot();
