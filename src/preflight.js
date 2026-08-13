// Runs before anything imports node:sqlite so an unsupported runtime produces
// an explanation instead of a stack trace.

const [major, minor] = process.versions.node.split('.').map(Number);

if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`
BotPanel requires Node.js 24 or newer (found ${process.versions.node}).

Install it from https://nodejs.org, your package manager, or run the panel
with the official Docker image, which bundles a supported runtime.
`);
  process.exit(1);
}

try {
  await import('node:sqlite');
} catch {
  console.error(`
This Node.js build (${process.versions.node}) does not expose node:sqlite.

Node.js 24 and newer enable it by default. On Node.js 22 you can start the
panel with:

  node --experimental-sqlite src/server.js
`);
  process.exit(1);
}
