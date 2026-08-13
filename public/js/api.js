/* REST client + realtime channel. Sessions ride on the cookie, so there is no
   token juggling here — `credentials: same-origin` is the whole auth story. */

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(method, path, body, options = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    ...options,
  };

  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`/api${path}`, init);

  if (response.status === 204) return null;

  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const payload = isJson ? await response.json().catch(() => ({})) : await response.text();

  if (!response.ok) {
    const message = (isJson && payload?.error) || `Request failed (${response.status})`;
    throw new ApiError(response.status, message, payload?.details);
  }
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
};

/**
 * Realtime feed. Reconnects with backoff, replays subscriptions on reconnect,
 * and reports connection state so the UI can show whether it is live.
 */
export class Live {
  constructor() {
    this.socket = null;
    this.channels = new Set();
    this.handlers = new Map();     // channel -> Set<fn>
    this.stateHandlers = new Set();
    this.attempt = 0;
    this.closedByUs = false;
  }

  connect() {
    this.closedByUs = false;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.#emitState('live');
      if (this.channels.size > 0) {
        socket.send(JSON.stringify({ action: 'subscribe', channels: [...this.channels] }));
      }
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      for (const handler of this.handlers.get(message.channel) ?? []) {
        try {
          handler(message);
        } catch (err) {
          console.error('[live handler]', err);
        }
      }
    });

    socket.addEventListener('close', (event) => {
      this.#emitState('dead');
      if (this.closedByUs) return;
      // 4001 means the server revoked the session — a reload sends us to login.
      if (event.code === 4001) {
        location.reload();
        return;
      }
      const delay = Math.min(1000 * 2 ** this.attempt++, 15000);
      setTimeout(() => this.connect(), delay);
    });

    socket.addEventListener('error', () => socket.close());
  }

  disconnect() {
    this.closedByUs = true;
    this.socket?.close();
  }

  subscribe(channels) {
    const added = channels.filter((channel) => !this.channels.has(channel));
    for (const channel of channels) this.channels.add(channel);
    if (added.length > 0 && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ action: 'subscribe', channels: added }));
    }
  }

  unsubscribe(channels) {
    for (const channel of channels) this.channels.delete(channel);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ action: 'unsubscribe', channels }));
    }
  }

  /** Returns an unsubscribe function, which makes view teardown a one-liner. */
  on(channel, handler) {
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
    this.handlers.get(channel).add(handler);
    return () => this.handlers.get(channel)?.delete(handler);
  }

  onState(handler) {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  #emitState(state) {
    for (const handler of this.stateHandlers) handler(state);
  }
}

export const live = new Live();
