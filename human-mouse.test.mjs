import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  randomGaussian, cubicBezier, humanEase, generateHumanPath,
  humanMouseMove, humanMouseClick, humanScroll, humanIdleDrift, humanInteract,
  findFloatingAds, getMousePos, setMousePos,
} from './human-mouse.mjs';

function mockCdp(viewport = { w: 1280, h: 800 }) {
  const calls = [];
  return {
    calls,
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify(viewport) } };
      return {};
    },
    inputs: () => calls.filter(c => c.method === 'Input.dispatchMouseEvent'),
  };
}

test('randomGaussian generates numbers centered near mean', () => {
  const samples = [];
  for (let i = 0; i < 1000; i++) samples.push(randomGaussian(10, 2));
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(Math.abs(avg - 10) < 0.4, `average should be near 10, got ${avg}`);
});

test('cubicBezier computes endpoints and midpoint', () => {
  assert.equal(cubicBezier(0, 25, 75, 100, 0), 0);
  assert.equal(cubicBezier(0, 25, 75, 100, 1), 100);
  assert.equal(cubicBezier(0, 0, 100, 100, 0.5), 50);
});

test('humanEase produces symmetric S-curve', () => {
  assert.equal(humanEase(0), 0);
  assert.equal(humanEase(1), 1);
  assert.equal(humanEase(0.5), 0.5);
  assert.ok(humanEase(0.2) < 0.2);
  assert.ok(humanEase(0.8) > 0.8);
});

test('generateHumanPath ends exactly at target with bounded delays', () => {
  const path = generateHumanPath(100, 100, 500, 400);
  assert.ok(path.length >= 10, 'path should contain multiple interpolation points');
  const last = path[path.length - 1];
  assert.equal(last.x, 500);
  assert.equal(last.y, 400);
  for (const p of path) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    assert.ok(p.delayMs >= 3 && p.delayMs <= 22);
  }
  // 距离过近时退化为单点
  assert.deepEqual(generateHumanPath(10, 10, 11, 10), [{ x: 11, y: 10, delayMs: 10 }]);
});

test('humanMouseMove dispatches mouseMoved points through the trajectory', async () => {
  const cdp = mockCdp();
  setMousePos(cdp, 50, 50);
  await humanMouseMove(cdp, 150, 150, { tremorMagnitude: 0 });
  const inputs = cdp.inputs();
  assert.ok(inputs.length > 5, 'should move in multiple steps');
  for (const i of inputs) assert.equal(i.params.type, 'mouseMoved');
  const last = inputs[inputs.length - 1].params;
  assert.equal(last.x, 150);
  assert.equal(last.y, 150);
  assert.deepEqual(getMousePos(cdp), { x: 150, y: 150 });
});

test('humanMouseClick dispatches pressed before released with left button', async () => {
  const cdp = mockCdp();
  setMousePos(cdp, 10, 10);
  await humanMouseClick(cdp, 80, 80);
  const inputs = cdp.inputs();
  const pressed = inputs.findIndex(i => i.params.type === 'mousePressed');
  const released = inputs.findIndex(i => i.params.type === 'mouseReleased');
  assert.ok(inputs.some(i => i.params.type === 'mouseMoved'));
  assert.ok(pressed > 0 && released > pressed, 'press must precede release');
  assert.equal(inputs[pressed].params.button, 'left');
  assert.equal(inputs[pressed].params.clickCount, 1);
  assert.equal(inputs[pressed].params.buttons, 1);
  assert.equal(inputs[released].params.buttons, 0);
});

test('humanScroll dispatches damped wheel ticks with correct total', async () => {
  const cdp = mockCdp();
  setMousePos(cdp, 400, 300);
  await humanScroll(cdp, 200);
  const wheels = cdp.inputs().filter(i => i.params.type === 'mouseWheel');
  assert.ok(wheels.length >= 3, 'scroll should be split across ticks');
  const sumY = wheels.reduce((acc, w) => acc + w.params.deltaY, 0);
  assert.ok(sumY > 150, `total scroll ${sumY} should approach 200`);
  for (const w of wheels) {
    assert.equal(w.params.x, 400);
    assert.equal(w.params.y, 300);
    assert.equal(w.params.deltaX, 0);
  }
});

test('humanIdleDrift stays near the current position', async () => {
  const cdp = mockCdp();
  setMousePos(cdp, 300, 300);
  await humanIdleDrift(cdp);
  const pos = getMousePos(cdp);
  assert.ok(Math.abs(pos.x - 300) < 50);
  assert.ok(Math.abs(pos.y - 300) < 50);
});

test('humanInteract respects its time budget and performs actions', async () => {
  const cdp = mockCdp();
  const t0 = Date.now();
  const r = await humanInteract(cdp, 1.2);
  const dt = Date.now() - t0;
  assert.ok(dt <= 1600, `interaction must fit the budget, took ${dt}ms`);
  assert.ok(r.actions >= 1, 'at least one action should run');
  assert.ok(cdp.inputs().length >= 1, 'input events must be dispatched');
});

test('humanInteract exits immediately when stopped', async () => {
  const cdp = mockCdp();
  const t0 = Date.now();
  const r = await humanInteract(cdp, 5, { isStopped: () => true });
  assert.equal(r.actions, 0);
  assert.equal(cdp.inputs().length, 0);
  assert.ok(Date.now() - t0 < 200);
});

test('humanInteract does nothing for zero seconds', async () => {
  const cdp = mockCdp();
  const r = await humanInteract(cdp, 0);
  assert.deepEqual(r, { actions: 0, clicks: 0, scrolls: 0, adClicks: 0 });
  assert.equal(cdp.calls.length, 0);
});

test('humanMouseMove is paced by sleeps, not by CDP acknowledgement latency', async () => {
  const cdp = { send: async () => { await new Promise(r => setTimeout(r, 200)); return {}; } };
  setMousePos(cdp, 100, 100);
  const t0 = Date.now();
  await humanMouseMove(cdp, 500, 400, { tremorMagnitude: 0 });
  const dt = Date.now() - t0;
  // 约 50 个轨迹点；若逐点等待 200ms 应答将超过 9 秒
  assert.ok(dt < 2500, `move must not wait for slow acknowledgements, took ${dt}ms`);
});

test('humanInteract performs the requested number of clicks', async () => {
  const cdp = mockCdp();
  const t0 = Date.now();
  const r = await humanInteract(cdp, 10, { clicks: 2 });
  assert.equal(r.clicks, 2, 'two click attempts must run within the budget');
  assert.ok(Date.now() - t0 <= 10500, 'clicks must fit the budget');
});

test('humanInteract auto mode continues while clicks produce ads', async () => {
  const cdp = mockCdp();
  const r = await humanInteract(cdp, 20, { clicks: 'auto', hasNewAd: () => true });
  assert.ok(r.clicks >= 3, `auto mode must keep clicking while ads appear, got ${r.clicks}`);
});

test('humanInteract auto mode stops after two unproductive clicks', async () => {
  const cdp = mockCdp();
  const r = await humanInteract(cdp, 13, { clicks: 'auto', hasNewAd: () => false });
  assert.equal(r.clicks, 2, 'two consecutive unproductive clicks must stop auto mode');
});

test('findFloatingAds parses candidates and tolerates bad payloads', async () => {
  const mk = (value) => ({ send: async () => ({ result: { value } }) });
  const list = await findFloatingAds(mk('[{"x":400,"y":300,"w":120,"h":60,"z":9999}]'));
  assert.equal(list.length, 1);
  assert.equal(list[0].x, 400);
  assert.deepEqual(await findFloatingAds(mk('not-json')), []);
  assert.deepEqual(await findFloatingAds({ send: async () => { throw new Error('x'); } }), []);
});

test('humanInteract clicks a detected floating ad instead of a random spot', async () => {
  const cdp = {
    calls: [],
    send: async (method, params) => {
      cdp.calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const value = String(params.expression).includes('getBoundingClientRect')
          ? '[{"x":400,"y":300,"w":120,"h":60,"z":9999}]'
          : JSON.stringify({ w: 1280, h: 800 });
        return { result: { value } };
      }
      return {};
    },
  };
  const r = await humanInteract(cdp, 9, { clicks: 1 });
  assert.equal(r.clicks, 1);
  assert.equal(r.adClicks, 1, 'detected floating ad must be clicked');
  const pressed = cdp.calls.filter(c => c.method === 'Input.dispatchMouseEvent').find(i => i.params.type === 'mousePressed');
  assert.equal(pressed.params.x, 400);
  assert.equal(pressed.params.y, 300);
});
