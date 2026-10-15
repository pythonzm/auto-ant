import assert from 'node:assert/strict';
const profiles = new Map();
const targets = new Map();
let nextId = 0;
let active = 0;
let peak = 0;
let launches = 0;
let peakLaunches = 0;
let completed = 0;
let deleted = 0;
let inputEvents = 0;
let frontCalls = 0;
const fail = process.env.MOCK_FAIL === '1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const target = (port, id) => ({ id, type: 'page', url: 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${id}` });
const response = data => new Response(JSON.stringify(data), { status: 200 });
globalThis.fetch = async (input, options = {}) => {
  const u = new URL(input);
  const body = options.body ? JSON.parse(options.body) : {};
  if (u.pathname === '/api/health') return response({ ok: true });
  if (u.pathname === '/api/profiles' && options.method === 'POST') {
    const id = String(++nextId);
    profiles.set(id, 9000 + nextId);
    return response({ launchCode: id, profile: { profileId: id } });
  }
  if (u.pathname === '/api/launch') {
    launches++; peakLaunches = Math.max(peakLaunches, launches);
    await delay(50); launches--;
    return response({ ok: true, debugPort: profiles.get(body.code), pid: Number(body.code) });
  }
  if (u.pathname === '/json/list') return response([target(u.port, 'first')]);
  if (u.pathname === '/json/new') {
    assert.equal(options.method, 'PUT');
    return response(target(u.port, 'second'));
  }
  if (u.pathname === '/api/runtime/stop') {
    assert.equal(active, 0, 'cleanup must wait for all navigations');
    assert.equal(completed, Number(process.env.MOCK_EXPECT_COMPLETED || (fail ? 2 : 8)), 'cleanup must wait for all profiles and repeats');
    return response({ ok: true });
  }
  if (options.method === 'DELETE') { deleted++; return response({ ok: true }); }
  throw new Error(`Unexpected mock request ${u.pathname}`);
};
globalThis.WebSocket = class extends EventTarget {
  constructor(url) {
    super(); this.url = url;
    setTimeout(() => this.dispatchEvent(new Event('open')), 0);
  }
  async send(raw) {
    const m = JSON.parse(raw);
    const emit = data => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
    let result = {};
    if (fail && this.url.includes(':9001/') && m.method === 'Network.enable') {
      emit({ id: m.id, error: { message: 'intentional failure' } }); return;
    }
    if (m.method.startsWith('Input.')) inputEvents++;
    if (m.method === 'Page.bringToFront') frontCalls++;
    if (m.method === 'Page.navigate') {
      active++; peak = Math.max(peak, active);
      targets.set(this.url, m.params.url);
      emit({ method: 'Network.requestWillBeSent', params: { request: { url: m.params.url } } });
      await delay(80); active--; completed++;
    }
    if (m.method === 'Runtime.evaluate') {
      result = { result: { value: m.params.expression === 'document.readyState' ? 'complete' : JSON.stringify({ url: targets.get(this.url), title: 'mock' }) } };
    }
    emit({ id: m.id, result });
  }
  close() { this.dispatchEvent(new Event('close')); }
};
process.on('exit', () => {
  assert.equal(peakLaunches, 2, 'profiles must launch concurrently');
  assert.equal(peak, fail ? 2 : 4, 'all tabs and profiles must navigate concurrently');
  assert.equal(deleted, 2, 'all created profiles must be deleted');
  if (process.env.MOCK_EXPECT_INPUT === '1') {
    assert.ok(inputEvents > 0, 'interactions must dispatch input events');
    assert.ok(frontCalls >= 2, 'each tab must be brought to front before interacting');
  }
});
