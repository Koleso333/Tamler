const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackend } = require('../runtime/mac-helper.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tamler-mac-'));
  const folder = path.join(root, 'plugins', 'fixture');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({ id: 'fixture', hosts: ['https://allowed.example/*'], settings: [{ key: 'uploads', type: 'files' }] }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, backend: createBackend(root) };
}

test('Mac bridge routes plugin storage, chunked files and toggles into the shared store', async t => {
  const { root, backend } = fixture(t);
  await backend.command({ action: 'storage-set', pluginId: 'fixture', key: 'value', value: 'stored' });
  await backend.command({ action: 'file-put', pluginId: 'fixture', key: 'uploads', name: 'file.txt', upload: 'testupload01', index: 0, last: false, data: Buffer.from('first').toString('base64') });
  const written = await backend.command({ action: 'file-put', pluginId: 'fixture', key: 'uploads', name: 'file.txt', upload: 'testupload01', index: 1, last: true, data: Buffer.from('second').toString('base64') });
  assert.deepEqual(written.data.uploads, [{ name: 'file.txt', size: 11 }]);
  const read = await backend.command({ action: 'file-get', pluginId: 'fixture', key: 'uploads', name: 'file.txt' });
  assert.equal(Buffer.from(read.data, 'base64').toString(), 'firstsecond');
  await backend.command({ action: 'file-remove', pluginId: 'fixture', key: 'uploads', name: 'file.txt' });
  assert.deepEqual((await backend.command({ action: 'file-list', pluginId: 'fixture', key: 'uploads' })).files, []);
  const toggled = await backend.command({ action: 'toggle', pluginId: 'fixture', enabled: false });
  assert.equal(toggled.state[0].enabled, false);
  const restarted = createBackend(root);
  assert.equal(restarted.list()[0].enabled, false);
  assert.equal(restarted.store.data('fixture').value, 'stored');
  await assert.rejects(backend.command({ action: 'file-get', pluginId: 'fixture', key: '../outside', name: 'file.txt' }), /Invalid file key/);
});

test('Mac networking rejects unlisted redirect destinations before fetching them', async t => {
  const { backend } = fixture(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return new Response(null, { status: 302, headers: { location: 'https://unlisted.example/secret' } });
  });
  await assert.rejects(backend.command({ action: 'net-fetch', pluginId: 'fixture', url: 'https://allowed.example/start' }), /Redirect to an unlisted host/);
  assert.deepEqual(calls, ['https://allowed.example/start']);
  await assert.rejects(backend.command({ action: 'net-fetch', pluginId: 'fixture', url: 'https://unlisted.example/direct' }), /Host is not listed/);
  assert.equal(calls.length, 1);
});

test('Mac networking aborts responses beyond the plugin download limit', async t => {
  const { backend } = fixture(t);
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return { status: 200, headers: new Headers(), body: (async function* () { yield Buffer.alloc(16 * 1024 * 1024); yield Buffer.alloc(16 * 1024 * 1024 + 1); })() };
  });
  await assert.rejects(backend.command({ action: 'net-fetch', pluginId: 'fixture', url: 'https://allowed.example/large' }), /larger than 32 MB/);
  assert.equal(signal.aborted, true);
});
