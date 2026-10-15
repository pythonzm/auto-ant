import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForLoad, waitForQuiet } from './visit-waits.mjs';

test('load waiting can be disabled without CDP calls', async () => {
  assert.equal(await waitForLoad(null, 0), 'off');
});

test('load waiting observes complete', async () => {
  const cdp = { send: async () => ({ result: { value: 'complete' } }) };
  assert.equal(await waitForLoad(cdp, 1), 'complete');
});

test('loading page reaches deadline and passes remaining time to CDP', async () => {
  const cdp = { send: async (_method, _params, timeout) => {
    assert.ok(timeout > 0 && timeout <= 50);
    return { result: { value: 'loading' } };
  } };
  assert.equal(await waitForLoad(cdp, 0.05), 'timeout');
});

test('transient evaluation failures remain bounded', async () => {
  assert.equal(await waitForLoad({ send: async () => { throw new Error('context destroyed'); } }, 0.05), 'timeout');
});

test('settling can be disabled', async () => {
  assert.deepEqual(await waitForQuiet([], 0, 1), { settleMs: 0, settleState: 'off' });
});

test('non-request events do not reset quiet window', async () => {
  const events = [];
  const timer = setInterval(() => events.push({ method: 'Network.dataReceived' }), 10);
  try {
    const result = await waitForQuiet(events, 0.08, 0.5);
    assert.equal(result.settleState, 'quiet');
    assert.ok(result.settleMs >= 80);
  } finally { clearInterval(timer); }
});

test('repeated requests to the same URL keep resetting quiet window until cap', async () => {
  const events = [];
  const timer = setInterval(() => events.push({ method: 'Network.requestWillBeSent', params: { request: { url: 'http://localhost/same' } } }), 10);
  try {
    const result = await waitForQuiet(events, 0.15, 0.25);
    assert.equal(result.settleState, 'timeout');
    assert.ok(result.settleMs >= 250);
  } finally { clearInterval(timer); }
});
