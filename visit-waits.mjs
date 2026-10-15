import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

export async function waitForLoad(cdp, seconds) {
  if (seconds === 0) return 'off';
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    const state = await cdp.send('Runtime.evaluate', {
      returnByValue: true, expression: 'document.readyState',
    }, remaining).catch(() => null);
    if (state?.result?.value === 'complete') return 'complete';
    await sleep(Math.max(0, Math.min(500, deadline - performance.now())));
  }
  return 'timeout';
}

// Observe all request starts, including repeated URLs. The quiet window starts
// after --hold; ongoing requests are not the same as new request starts.
export async function waitForQuiet(events, seconds, maxSeconds) {
  if (seconds === 0) return { settleMs: 0, settleState: 'off' };
  const start = performance.now();
  const deadline = start + maxSeconds * 1000;
  let lastChange = start;
  let cursor = events.length;
  while (true) {
    const now = performance.now();
    for (; cursor < events.length; cursor++) {
      if (events[cursor].method === 'Network.requestWillBeSent') lastChange = now;
    }
    if (now - lastChange >= seconds * 1000) {
      return { settleMs: Math.round(now - start), settleState: 'quiet' };
    }
    if (now >= deadline) return { settleMs: Math.round(now - start), settleState: 'timeout' };
    await sleep(Math.max(0, Math.min(100, deadline - now, lastChange + seconds * 1000 - now)));
  }
}
