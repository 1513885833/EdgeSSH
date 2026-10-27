import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '../lib/client.mjs';
import { siteOrigin } from '../lib/config.mjs';

async function server(handler, run) {
  const http = createServer(handler); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  try { await run(`http://127.0.0.1:${http.address().port}`); }
  finally { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
}

test('only HTTPS origins and loopback development URLs are accepted', () => {
  assert.equal(siteOrigin('https://ssh.example.com'), 'https://ssh.example.com');
  assert.equal(siteOrigin('http://localhost:8787'), 'http://localhost:8787');
  for (const value of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?token=secret']) assert.throws(() => siteOrigin(value));
});
test('Access HTTP redirects are refused and credentials never follow them', async () => {
  let redirected = false;
  await server((request, response) => {
    if (request.url === '/api/hosts') { response.writeHead(302, { location: '/stolen' }); response.end(); }
    else { redirected = true; response.end(); }
  }, async origin => {
    const client = new Client(origin, 'test.token.signature', new AbortController().signal);
    await assert.rejects(client.request('/api/hosts'), /login/);
  });
  assert.equal(redirected, false);
});
test('Access credentials and Origin are attached to JSON requests', async () => {
  await server((request, response) => {
    assert.equal(request.headers.cookie, 'CF_Authorization=test.token.signature');
    assert.equal(request.headers['cf-access-token'], 'test.token.signature');
    assert.ok(request.headers.origin.startsWith('http://127.0.0.1:'));
    assert.equal(request.method, 'POST'); assert.equal(request.headers['content-type'], 'application/json');
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ticket":"fixture"}');
  }, async origin => {
    const client = new Client(origin, 'test.token.signature', new AbortController().signal);
    assert.deepEqual(await client.request('/api/session', {}), { ticket: 'fixture' });
    await assert.rejects(client.open('https://evil.example.com/api/sftp'), /Invalid WebSocket/);
  });
});
test('login invokes cloudflared, saves only origin, and never prints the token', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'edgessh-login-'));
  const log = join(directory, 'calls'); const token = 'test.token.signature';
  await writeFile(join(directory, 'cloudflared'), `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n'); process.stdout.write(${JSON.stringify(token)} + '\\n');\n`, { mode: 0o700 });
  const config = join(directory, 'config.json');
  async function cli(origin, ...args) {
    const child = spawn(process.execPath, [new URL('../bin.mjs', import.meta.url).pathname, '--url', origin, ...args], {
      env: { ...process.env, EDGESSH_ACCESS_TOKEN: '', EDGESSH_CONFIG: config, PATH: `${directory}:${process.env.PATH}` },
    });
    let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    const [code] = await once(child, 'close'); return { code, stdout, stderr };
  }
  try {
    await server((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"provider":"cloudflare","account":{"id":"fixture"}}'); }, async origin => {
      const login = await cli(origin, 'login'); assert.equal(login.code, 0, login.stderr);
      assert.ok(!login.stdout.includes(token)); assert.ok(!login.stderr.includes(token));
      const stored = await readFile(config, 'utf8'); assert.ok(!stored.includes(token)); assert.equal(JSON.parse(stored).origin, origin);
      const status = await cli(origin, 'status'); assert.equal(status.code, 0, status.stderr);
      assert.equal(await readFile(log, 'utf8'), `access login ${origin}\naccess token -app=${origin}\n`);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
