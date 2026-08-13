/**
 * WebSocket pub/sub.
 *
 * Channels: `bots` (status changes), `stats` (resource samples), `events`,
 * `logs:<botId>` and `deploy:<botId>`.
 */

const clients = new Set();

export function addClient(socket, user) {
  const client = { socket, user, channels: new Set(['bots', 'stats', 'events']) };
  clients.add(client);
  socket.on('close', () => clients.delete(client));
  return client;
}

export function subscribe(client, channels) {
  for (const channel of channels) {
    if (typeof channel === 'string' && channel.length < 128) client.channels.add(channel);
  }
}

export function unsubscribe(client, channels) {
  for (const channel of channels) client.channels.delete(channel);
}

export function publish(channel, type, data) {
  if (clients.size === 0) return;

  const frame = JSON.stringify({ channel, type, data, ts: Date.now() });
  for (const client of clients) {
    if (!client.channels.has(channel) || client.socket.readyState !== 1) continue;
    try {
      client.socket.send(frame);
    } catch {
      // The close handler will clean up a socket that is already going away.
    }
  }
}

export const clientCount = () => clients.size;

export function disconnectUser(userId) {
  for (const client of clients) {
    if (client.user?.id === userId) client.socket.close(4001, 'Session ended');
  }
}
