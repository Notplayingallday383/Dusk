import { expect, test } from 'vitest';
import { bootRepl } from '../src/index';

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!predicate()) throw new Error('timed out waiting for condition');
};

test('allows ordinary https fetch-backed requests', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const out: string[] = [];
  const repl = await bootRepl((text) => out.push(text), { fs: 'memory' });
  try {
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), method: init?.method });
      return new Response('ok', { status: 200 });
    };
    await repl.feed([
      "const https = require('node:https');",
      "const req = https.request(new URL('https://example.test/resource?via=url'), { method: 'POST' }, (res) => {",
      "  res.on('data', () => {});",
      "  res.on('end', () => process.stdout.write('STATUS=' + res.statusCode + ':END'));",
      '});',
      "req.end('body');",
      '',
    ].join(' '));
    await waitFor(() => out.join('').includes(':END'));

    expect(out.join('')).toContain('STATUS=200:END');
    expect(requests).toEqual([{ url: 'https://example.test/resource?via=url', method: 'POST' }]);
  } finally {
    globalThis.fetch = originalFetch;
    await repl.engine.terminate();
  }
}, 60_000);

test('rejects unsupported TLS controls before transport', async () => {
  const out: string[] = [];
  const repl = await bootRepl((text) => out.push(text), { fs: 'memory' });
  try {
    await repl.feed([
      "const https = require('node:https');",
      "const options = { ca: 'custom', cert: 'cert', key: 'key', pfx: 'pfx', passphrase: 'secret', crl: 'crl', rejectUnauthorized: false, servername: 'example.test', secureContext: {}, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3', secureProtocol: 'TLSv1_2_method', secureOptions: 1, sigalgs: 'rsa_pss_rsae_sha256', ecdhCurve: 'prime256v1', ALPNProtocols: ['h2'], session: 'session', enableTrace: true, minDHSize: 1024, clientCertEngine: 'engine', privateKeyEngine: 'engine', privateKeyIdentifier: 'key-id', requestOCSP: true, allowPartialTrustChain: true, agent: {}, checkServerIdentity: () => undefined, pskCallback: () => undefined, ALPNCallback: () => undefined, SNICallback: () => undefined, keylog: () => undefined, ciphers: 'AES128-GCM-SHA256' };",
      "for (const name of Object.keys(options)) { try { https.request({ host: 'example.test', [name]: options[name] }); process.stdout.write('ALLOWED=' + name + ':'); } catch (error) { process.stdout.write(name + '=' + error.message + ':'); } }",
      "process.stdout.write('END');",
      '',
    ].join(' '));
    await waitFor(() => out.join('').includes('END'));

    const text = out.join('');
    for (const name of ['ca', 'cert', 'key', 'pfx', 'passphrase', 'crl', 'rejectUnauthorized', 'servername', 'secureContext', 'minVersion', 'maxVersion', 'secureProtocol', 'secureOptions', 'sigalgs', 'ecdhCurve', 'ALPNProtocols', 'session', 'enableTrace', 'minDHSize', 'clientCertEngine', 'privateKeyEngine', 'privateKeyIdentifier', 'requestOCSP', 'allowPartialTrustChain', 'agent', 'checkServerIdentity', 'pskCallback', 'ALPNCallback', 'SNICallback', 'keylog', 'ciphers']) {
      expect(text).toContain(`${name}=browser HTTPS does not support ${name}:`);
    }
    expect(text).not.toContain('ALLOWED=');
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);

test('rejects every TLS control when HTTPS URL-object overload explicitly uses HTTP', async () => {
  const out: string[] = [];
  const repl = await bootRepl((text) => out.push(text), { fs: 'memory' });
  try {
    await repl.feed([
      "const https = require('node:https');",
      "const options = { ca: 'custom', cert: 'cert', key: 'key', pfx: 'pfx', passphrase: 'secret', crl: 'crl', rejectUnauthorized: false, servername: 'example.test', secureContext: {}, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3', secureProtocol: 'TLSv1_2_method', secureOptions: 1, sigalgs: 'rsa_pss_rsae_sha256', ecdhCurve: 'prime256v1', ALPNProtocols: ['h2'], session: 'session', enableTrace: true, minDHSize: 1024, clientCertEngine: 'engine', privateKeyEngine: 'engine', privateKeyIdentifier: 'key-id', requestOCSP: true, allowPartialTrustChain: true, agent: {}, checkServerIdentity: () => undefined, pskCallback: () => undefined, ALPNCallback: () => undefined, SNICallback: () => undefined, keylog: () => undefined, ciphers: 'AES128-GCM-SHA256' };",
      "for (const name of Object.keys(options)) { try { https.request(new URL('http://example.test/resource'), { [name]: options[name] }); process.stdout.write('ALLOWED=' + name + ':'); } catch (error) { process.stdout.write(name + '=' + error.message + ':'); } }",
      "process.stdout.write('END');",
      '',
    ].join(' '));
    await waitFor(() => out.join('').includes('END'));

    const text = out.join('');
    for (const name of ['ca', 'cert', 'key', 'pfx', 'passphrase', 'crl', 'rejectUnauthorized', 'servername', 'secureContext', 'minVersion', 'maxVersion', 'secureProtocol', 'secureOptions', 'sigalgs', 'ecdhCurve', 'ALPNProtocols', 'session', 'enableTrace', 'minDHSize', 'clientCertEngine', 'privateKeyEngine', 'privateKeyIdentifier', 'requestOCSP', 'allowPartialTrustChain', 'agent', 'checkServerIdentity', 'pskCallback', 'ALPNCallback', 'SNICallback', 'keylog', 'ciphers']) {
      expect(text).toContain(`${name}=browser HTTPS does not support ${name}:`);
    }
    expect(text).not.toContain('ALLOWED=');
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);

test('ESM https facades reject URL-object TLS controls', async () => {
  const out: string[] = [];
  const repl = await bootRepl((text) => out.push(text), { fs: 'memory' });
  try {
    await repl.feed([
      '(async () => {',
      "  const modules = await Promise.all([import('https'), import('node:https')]);",
      "  for (const [name, mod] of [['https', modules[0]], ['node:https', modules[1]]]) {",
      "    try { mod.request(new URL('http://example.test/resource'), { ca: 'custom' }); process.stdout.write('ALLOWED=' + name + ':'); }",
      "    catch (error) { process.stdout.write(name + '=' + error.message + ':'); }",
      '  }',
      "  process.stdout.write('END');",
      '})()',
      '',
    ].join(' '));
    await waitFor(() => out.join('').includes('END'));

    const text = out.join('');
    expect(text).toContain('https=browser HTTPS does not support ca:');
    expect(text).toContain('node:https=browser HTTPS does not support ca:');
    expect(text).not.toContain('ALLOWED=');
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);

test('HTTPS aliases reject TLS server creation while HTTP server creation remains available', async () => {
  const out: string[] = [];
  const repl = await bootRepl((text) => out.push(text), { fs: 'memory' });
  try {
    await repl.feed([
      "const https = require('https');",
      "const nodeHttps = require('node:https');",
      "const http = require('node:http');",
      "for (const [name, mod] of [['https', https], ['node:https', nodeHttps]]) { try { mod.createServer({ key: 'key', cert: 'cert' }); process.stdout.write('ALLOWED=' + name + ':'); } catch (error) { process.stdout.write(name + '=' + error.message + ':'); } }",
      "process.stdout.write('HTTP=' + typeof http.createServer(() => {}).listen + ':END');",
      '',
    ].join(' '));
    await waitFor(() => out.join('').includes(':END'));

    const text = out.join('');
    expect(text).toContain('https=browser HTTPS does not support TLS servers:');
    expect(text).toContain('node:https=browser HTTPS does not support TLS servers:');
    expect(text).toContain('HTTP=function:END');
    expect(text).not.toContain('ALLOWED=');
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);
