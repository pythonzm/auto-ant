#!/usr/bin/env node
/**
 * ant-batch-visit.mjs —「有头」Ant 指纹浏览器批量访问 URL（经本地 Launch API）
 * 需要 Node >= 22（内置 fetch / WebSocket；等待和采集需要内置 WebSocket）
 *
 * 快速开始:
 *   node ant-batch-visit.mjs --help
 *   node ant-batch-visit.mjs --count 3 --hold 12 --check-ip --capture
 *   node ant-batch-visit.mjs --url https://a.com --url https://b.com --count 3 --repeat 2
 *   node ant-batch-visit.mjs --urls-file urls.txt --count 5 --no-proxy
 *
 * 参数（括号内为默认值）:
 *   --api <base>      (http://127.0.0.1:19876)  Launch API 地址
 *   --url <u>         可重复；目标 URL（默认内置博客页）
 *   --urls-file <p>   从文本文件读 URL（每行一个，# 开头忽略）
 *   --count <n>       (3)    并发实例数
 *   --repeat <n>      (1)    每个实例对每个 URL 的访问次数
 *   --hold <sec>      (8)    等 load 完成后【额外】停留的秒数
 *   --wait-load <sec> (15)   先等 document.readyState=complete（最多 N 秒；0=不等，直接进 --hold）
 *   --referer <url|auto|none> (auto) 访问来路（默认根据目标生成搜索/社媒来源，伪造 document.referrer）
 *   --no-referer      不设置 Referer
 *   --reuse-profile   复用同名前缀的已有 profile，结束时不删除（保留 Cookie/历史痕迹）
 *   --swiftshader     (默认开启) 补充 --enable-unsafe-swiftshader 避免无 GPU 报错；--no-swiftshader 关闭
 *   --settle-ads <sec> (0)   数广告模式：连续 N 秒无新请求才结束（0=关闭）
 *   --settle-max <sec> (30)  --settle-ads 的硬上限（防止页面持续加载时无限等）
 *   --proxy <url>     (flame 轮换) 代理；--no-proxy 走直连
 *   --proxy-id <id>   (flame 的 id) 需与 --proxy 匹配的既有代理 id（见 --help 末尾说明）
 *   --core-id <id>    (自动探测：取现有 profile 的 coreId)
 *   --prefix <name>   (batch) 新建 profile / userDataDir 前缀
 *   --seed <n>        (479973100) 指纹种子基数（第 i 个实例 = seed + i）
 *   --lang <l>        (en-US)
 *   --timezone <tz>   (America/Los_Angeles)
 *   --window <WxH>    (1920x1080)
 *   --hw <n>          (8)    --fingerprint-hardware-concurrency
 *   --ua <string>     附加 --user-agent=<string>
 *   --check-ip        每次访问前用该实例查出口 IP（api.ipify.org）
 *   --capture         兼容保留；CDP 采集（请求/广告/弹窗统计）现已始终开启
 *   --keep            跑完不停止、不删除实例与 profile
 *   --no-interact      关闭拟人鼠标交互（默认开启：--hold 期间模拟移动/滚动/点击）
 *   --clicks <n|auto>  (auto) 点击次数：auto=连点至连续 2 次无新广告（上限 6）；或固定次数（0=不点击）
 *   --no-float        关闭漂浮广告检测点击（默认开启：点击前优先点击浮层广告）
 *   --json            以 JSON 输出全部结果
 *   --timeout <sec>   (90)   单次 API 调用超时
 *   --retry <n>       (2)    访问失败（chrome-error / 导航错误）时的额外重试次数
 *   --retry-delay <s> (3)    每次重试前的等待秒数
 *   --help
 *
 * 说明:
 *   - 有头是默认行为：API 启动的实例就是桌面上的有头窗口。
 *   - 弹窗仅前台（可见）标签可触发：交互阶段按队列逐个 bringToFront 串行执行（加载仍并行），
 *     总交互时长约为各访问 --hold 之和。
 *   - 同一 profile 重复启动是幂等的 → 每个实例创建一个 profile；多个 URL 分别在独立标签页并行访问。
 *   - 结束（含 Ctrl-C）自动 stop + delete 本次创建的 profile；--keep 或 --reuse-profile 可关闭删除。
 *   - PROXY_ID 留空一般也能建 profile，但部分版本要求与 --proxy 匹配的既有代理 id：
 *     可在 Ant 界面「代理」页查看，或从 GET /api/profiles 里已有 profile 的 proxyId 取。
 */

import fs from 'node:fs';
import { waitForLoad, waitForQuiet } from './visit-waits.mjs';
import { humanInteract } from './human-mouse.mjs';

const BOOL = new Set(['--check-ip', '--capture', '--keep', '--json', '--no-proxy', '--interact', '--no-interact', '--no-float', '--no-referer', '--reuse-profile', '--swiftshader', '--no-swiftshader', '--help']);

const o = {
  api: process.env.ANT_API || 'http://127.0.0.1:19876',
  urls: [], urlsFile: null,
  count: 3, repeat: 1, hold: 8,
  proxy: 'http://flmb0279c28-package-standard:8f7bd52e@proxy.flameproxies.com:8989',
  proxyId: 'proxy-1791956972868-u27ov1',
  coreId: '', prefix: 'batch', seed: 479973100,
  lang: 'en-US', timezone: 'America/Los_Angeles', window: '1920x1080', hw: 8, ua: '',
  checkIp: false, capture: false, keep: false, json: false, noProxy: false, interact: true, clicks: 'auto', floatClick: true, timeout: 90,
  retry: 2, retryDelay: 3, waitLoad: 15, settleAds: 0, settleMax: 30,
  referer: 'auto', reuseProfile: false, swiftshader: true,
  help: false,
};
const DEFAULT_URL = 'https://blog.20231106.xyz/posts/2026-04-09/reasoning-models-slow-thinking-2026/';

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  let a = argv[i], v = null;
  if (a.includes('=')) { const p = a.split('='); a = p[0]; v = p.slice(1).join('='); }
  else if (!BOOL.has(a)) { v = argv[++i]; }
  switch (a) {
    case '--api': o.api = v; break;
    case '--url': o.urls.push(v); break;
    case '--urls-file': o.urlsFile = v; break;
    case '--count': o.count = +v; break;
    case '--repeat': o.repeat = +v; break;
    case '--hold': o.hold = +v; break;
    case '--proxy': o.proxy = v; break;
    case '--proxy-id': o.proxyId = v; break;
    case '--core-id': o.coreId = v; break;
    case '--prefix': o.prefix = v; break;
    case '--seed': o.seed = +v; break;
    case '--lang': o.lang = v; break;
    case '--timezone': o.timezone = v; break;
    case '--window': o.window = v; break;
    case '--hw': o.hw = +v; break;
    case '--ua': o.ua = v; break;
    case '--referer': o.referer = v; break;
    case '--no-referer': o.referer = 'none'; break;
    case '--reuse-profile': o.reuseProfile = true; break;
    case '--swiftshader': o.swiftshader = true; break;
    case '--no-swiftshader': o.swiftshader = false; break;
    case '--timeout': o.timeout = +v; break;
    case '--retry': o.retry = Math.max(0, +v); break;
    case '--retry-delay': o.retryDelay = +v; break;
    case '--wait-load': o.waitLoad = +v; break;
    case '--settle-ads': o.settleAds = +v; break;
    case '--settle-max': o.settleMax = +v; break;
    case '--check-ip': o.checkIp = true; break;
    case '--capture': o.capture = true; break;
    case '--keep': o.keep = true; break;
    case '--json': o.json = true; break;
    case '--no-proxy': o.noProxy = true; break;
    case '--interact': o.interact = true; break;
    case '--no-interact': o.interact = false; break;
    case '--no-float': o.floatClick = false; break;
    case '--clicks': o.clicks = v === 'auto' ? 'auto' : Math.max(0, Math.floor(+v)); break;
    case '--help': o.help = true; break;
    default: console.error(`未知参数: ${a}（用 --help 查看）`); process.exit(2);
  }
}
if (o.help) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '')); process.exit(0); }
for (const key of ['hold', 'waitLoad', 'settleAds', 'settleMax', 'timeout']) {
  if (!Number.isFinite(o[key]) || o[key] < 0 || (['settleMax', 'timeout'].includes(key) && o[key] === 0)) {
    console.error(`无效的等待参数 ${key}: ${o[key]}`); process.exit(2);
  }
}
if (o.clicks !== 'auto' && (!Number.isFinite(o.clicks) || o.clicks < 0)) {
  console.error(`无效的 clicks 参数: ${o.clicks}（应为 auto 或非负整数）`); process.exit(2);
}
for (const key of ['count', 'repeat']) {
  if (!Number.isSafeInteger(o[key]) || o[key] < 1) { console.error(`${key} 必须是正整数`); process.exit(2); }
}
if (o.urlsFile) {
  o.urls = o.urls.concat(fs.readFileSync(o.urlsFile, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')));
}
if (!o.urls.length) o.urls = [DEFAULT_URL];
if (o.noProxy) { o.proxy = ''; o.proxyId = ''; }

const say = (...a) => (o.json ? console.error : console.log)(...a);
const jerr = (e) => (e && e.message) || String(e);
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));
const hasWS = typeof WebSocket === 'function';
const needsCdp = true; // 独立标签页和重复访问统一由 CDP 管理。
if (needsCdp && !hasWS) { console.error('等待和采集需要 Node >= 22 的内置 WebSocket'); process.exit(2); }

// 通用重试：fn 返回 {ok:false} 或抛错都会重试，最多 o.retry 次额外尝试
async function withRetry(label, fn) {
  let last;
  for (let a = 0; a <= o.retry; a++) {
    if (a) { say(`    ↻ ${label} 重试 ${a}/${o.retry}（等待 ${o.retryDelay}s）`); await sleep(o.retryDelay); }
    try { last = await fn(a); if (last && last.ok === false) continue; return last; }
    catch (e) { last = { ok: false, err: jerr(e) }; }
  }
  return last;
}

// ---------- API ----------
async function api(path, init = {}) {
  const ctl = AbortSignal.timeout(o.timeout * 1000);
  const res = await fetch(o.api + path, { ...init, signal: ctl });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { }
  return { status: res.status, data, text };
}
const POST = (p, b) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

function fpArgs(idx) {
  const [w, h] = o.window.toLowerCase().split('x');
  const a = [
    `--fingerprint=${o.seed + idx}`,
    '--fingerprint-brand=Chrome', '--fingerprint-platform=windows',
    `--lang=${o.lang}`, `--accept-lang=${o.lang},${o.lang.split('-')[0]}`,
    `--timezone=${o.timezone}`, `--window-size=${w},${h}`,
    `--fingerprint-hardware-concurrency=${o.hw}`,
    '--disable-non-proxied-udp',
    '--fingerprinting-canvas-image-data-noise', '--fingerprinting-client-rects-noise',
  ];
  if (o.ua) a.push(`--user-agent=${o.ua}`);
  return a;
}
const AD_RE = /acscdn|adcash|adexchangerapid|inpagepush|atagv2|videoslider|popcash|propellerads|adex|rtmark|adsbygoogle|doubleclick|googlesyndication|popunder|adsterra|monetag/i;

// ---------- 极简 CDP 客户端 ----------
async function attachCdp(debugPort, target = null) {
  const list = target ? [target] : await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(8000) })).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('无 page 目标');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const events = [];
  const failPending = (error) => {
    for (const p of pend.values()) p.reject(error);
    pend.clear();
  };
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    } else if (m.method) events.push(m);
  });
  ws.addEventListener('close', () => failPending(new Error('CDP 连接已关闭')));
  ws.addEventListener('error', () => failPending(new Error('CDP 连接失败')));
  await new Promise((res, rej) => {
    const timer = setTimeout(() => { ws.close(); rej(new Error('CDP 连接超时')); }, 8000);
    ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('CDP 连接失败')); }, { once: true });
    ws.addEventListener('close', () => { clearTimeout(timer); rej(new Error('CDP 连接已关闭')); }, { once: true });
  });
  const send = (method, params = {}, timeoutMs = o.timeout * 1000) => new Promise((resolve, reject) => {
    const i = ++id;
    const timer = setTimeout(() => { pend.delete(i); reject(new Error(`CDP ${method} 超时`)); }, timeoutMs);
    const finish = fn => value => { clearTimeout(timer); fn(value); };
    pend.set(i, { resolve: finish(resolve), reject: finish(reject) });
    try { ws.send(JSON.stringify({ id: i, method, params })); }
    catch (e) { pend.get(i).reject(e); pend.delete(i); }
  });
  return { targetId: page.id, ws, send, events, close: () => { failPending(new Error('CDP 连接已关闭')); try { ws.close(); } catch { } } };
}

function pickReferer(targetUrl, optReferer) {
  if (!optReferer || optReferer === 'none') return '';
  if (optReferer !== 'auto') return optReferer;
  const generic = [
    'https://www.google.com/',
    'https://www.bing.com/',
    'https://t.co/',
    'https://news.ycombinator.com/',
    'https://duckduckgo.com/',
  ];
  try {
    const u = new URL(targetUrl);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg && seg.length > 3) {
      const q = encodeURIComponent(seg.replace(/[-_.]+/g, ' '));
      return `https://www.google.com/search?q=${q}`;
    }
  } catch { }
  return generic[Math.floor(Math.random() * generic.length)];
}

// ---------- 主流程 ----------
const created = [];   // {name, code, id, port}
let results = [];
let cleanupTask;
let runningTasks = Promise.resolve();
let stopping = false;

function cleanup() {
  return cleanupTask ||= performCleanup();
}
async function performCleanup() {
  if (o.keep || o.reuseProfile) {
    say(o.reuseProfile ? '（--reuse-profile：保留 profile 历史痕迹与 Cookie，仅停止实例）' : '（--keep：保留实例与 profile，不清理）');
    if (!o.keep) {
      for (const c of created) await POST('/api/runtime/stop', { code: c.code }).catch(() => { });
    }
    return;
  }
  say('--- 清理本次创建的实例与 profile ---');
  for (const c of created) await POST('/api/runtime/stop', { code: c.code }).catch(() => { });
  await sleep(2);
  for (const c of created) {
    const r = await api(`/api/profiles/${c.id}`, { method: 'DELETE' }).catch(e => ({ text: jerr(e) }));
    say(`  delete ${c.name} -> ${r.text || '(无响应)'}`);
  }
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, async () => {
    stopping = true;
    await runningTasks.catch(() => {});
    await cleanup();
    process.exit(code);
  });
}

// 等所有并行任务结束后再传播错误，避免清理仍在运行的实例。
async function allFinished(tasks) {
  const outcomes = await Promise.allSettled(tasks);
  const failures = outcomes.filter(r => r.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(r => r.reason), failures.map(r => jerr(r.reason)).join('; '));
  return outcomes.map(r => r.value);
}

// 交互阶段串行队列：弹窗只在前台（可见）标签触发（广告脚本按 document.visibilityState 门控），
// 且同一时刻只有一个标签可见，因此各标签交互按队列逐个 bringToFront 后执行（加载仍并行）。
let interactQueue = Promise.resolve();
function withForeground(cdp, fn) {
  const run = interactQueue.then(async () => {
    try { await cdp.send('Page.bringToFront'); } catch { }
    await sleep(0.8);
    return fn();
  });
  interactQueue = run.catch(() => { });
  return run;
}

async function visitTab(rec, cdp, u, tabIndex) {
  try {
    await cdp.send('Network.enable', { maxPostDataSize: 65536 });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    for (let k = 1; k <= o.repeat && !stopping; k++) {
      let attempt = 0, s = null, ref = '';
      while (attempt <= o.retry) {
        attempt++;
        cdp.events.length = 0;
        const t0 = Date.now();
        let navErr = '';
        ref = pickReferer(u, o.referer);
        const navParams = { url: u };
        if (ref) {
          navParams.referrer = ref;
          try { await cdp.send('Network.setExtraHTTPHeaders', { headers: { 'Referer': ref } }); } catch { }
        }
        try { const nv = await cdp.send('Page.navigate', navParams); navErr = nv?.errorText || ''; } catch (e) { navErr = jerr(e); }

        // 先等加载，再额外停留（默认拟人交互），最后观察请求安静窗口。
        let loadState = navErr ? 'error' : await waitForLoad(cdp, o.waitLoad);
        let act = { clicks: 0, scrolls: 0 };
        if (o.interact && !navErr && o.hold > 0) act = await withForeground(cdp, () => humanInteract(cdp, o.hold, {
          isStopped: () => stopping,
          clicks: o.clicks,
          floatClick: o.floatClick,
          hasNewAd: (since) => cdp.events.slice(since).some(e =>
            e.method === 'Page.windowOpen' ||
            (e.method === 'Network.requestWillBeSent' && AD_RE.test(e.params.request.url))),
        }));
        else await sleep(o.hold);
        const { settleMs, settleState } = await waitForQuiet(cdp.events, o.settleAds, o.settleMax);

        // 4) 快照
        const st = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: 'JSON.stringify({url:location.href,title:document.title})' }).catch(() => null);
        const stateStr = st?.result?.value || '';
        let parsed = {}; try { parsed = JSON.parse(stateStr); } catch { }
        const failed = !!navErr || !parsed.url || parsed.url.startsWith('chrome-error://');
        if (failed) loadState = 'error';
        const reqs = [...new Set(cdp.events.filter(e => e.method === 'Network.requestWillBeSent').map(e => e.params.request.url))];
        const ads = reqs.filter(x => AD_RE.test(x));
        const popups = cdp.events.filter(e => e.method === 'Page.windowOpen')
          .map(e => e.params.url);

        s = { instance: rec.name, tab: tabIndex + 1, targetId: cdp.targetId, url: u, referer: ref || 'none', visit: k, attempts: attempt, ok: !failed, loadState, settleMs, settleState, elapsedMs: Date.now() - t0, state: stateStr, navError: navErr, reqs: reqs.length, adReqs: ads.length, adUrls: ads, clicks: act.clicks, scrolls: act.scrolls, floatClicks: act.adClicks, popups };
        if (!failed) break;
        if (attempt <= o.retry) { say(`    ↻ ${rec.name} #${k} 访问失败(${navErr || 'chrome-error'})，重试 ${attempt}/${o.retry}`); await sleep(o.retryDelay); }
      }
      const line = `  ${rec.name} #${k} ${String(u).slice(0, 50)} -> ${s.ok ? s.state : '!!失败: ' + (s.navError || 'chrome-error')}  reqs=${s.reqs} ad-reqs=${s.adReqs}  ref=${ref ? String(ref).slice(0, 30) : 'none'}  load=${s.loadState}${s.settleMs ? ` settle=${s.settleState}/${(s.settleMs / 1000).toFixed(1)}s` : ''}${s.attempts > 1 ? `  (尝试${s.attempts}次)` : ''}${o.interact ? `  act=${s.clicks}c/${s.scrolls}s` : ''}${s.floatClicks ? `  float=${s.floatClicks}` : ''}`;
      say(line + (s.popups.length ? `  popups=${s.popups.map(x => x.slice(0, 60)).join('|')}` : ''));
      results.push(s);
    }
  } finally { cdp.close(); }
}

async function runProfile(i) {
  const name = `${o.prefix}-${i}`;
  let code = '', id = '';
  if (o.reuseProfile) {
    const pj = await api('/api/profiles').catch(() => null);
    const found = pj?.data?.items?.find(p => p.profileName === name);
    if (found?.profileId && found?.launchCode) {
      code = found.launchCode;
      id = found.profileId;
      say(`  [${i}] 复用已有 profile ${name} (id=${id})`);
    }
  }

  const launchArgs = ['--disable-sync', '--no-first-run'];
  if (o.swiftshader) {
    launchArgs.push('--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist');
  }

  if (!code || !id) {
    const body = {
      profile: {
        profileName: name, userDataDir: name, coreId: o.coreId,
        fingerprintArgs: fpArgs(i),
        proxyId: o.proxyId, proxyConfig: o.proxy,
        launchArgs,
        tags: [o.prefix], keywords: [],
      },
    };
    const cr = await withRetry(`创建 ${name}`, async () => {
      const r = await POST('/api/profiles', body);
      return { ok: !!(r.data?.launchCode && r.data?.profile?.profileId), r };
    });
    code = cr?.r?.data?.launchCode;
    id = cr?.r?.data?.profile?.profileId;
    if (!code || !id) { say(`  [${i}] 创建失败: ${cr?.r?.text?.slice(0, 200) || cr?.err || '未知'}`); throw new Error(`创建 ${name} 失败`); }
  }
  const rec = { name, code, id, port: 0 }; created.push(rec);
  if (stopping) return;

  const startUrls = ['about:blank'];
  const lr = await withRetry(`启动 ${name}`, async () => {
    const r = await POST('/api/launch', { code, startUrls, skipDefaultStartUrls: true });
    return { ok: !!r.data?.ok, r };
  });
  rec.port = lr?.r?.data?.debugPort || 0;
  if (!o.json) say(`  [${i}] ${name}  code=${code}  ok=${lr?.r?.data?.ok}  debugPort=${rec.port}  pid=${lr?.r?.data?.pid}`);
  if (!lr?.r?.data?.ok || !rec.port) throw new Error(`启动 ${name} 失败或缺少 debugPort`);
  if (stopping) return;
  const connection = await withRetry(`${name} CDP`, async () => attachCdp(rec.port));
  if (!connection?.send) throw new Error(`${name}: CDP 失败 (${connection?.err || '未知'})`);
  const cdp = connection;
  const tabs = [cdp];
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    if (o.checkIp) {
      cdp.events.length = 0;
      await cdp.send('Page.navigate', { url: 'https://api.ipify.org/?format=json' });
      await sleep(6);
      const r = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: 'document.body?document.body.innerText.slice(0,80):""' });
      const ip = (r?.result?.value || '').replace(/\s+/g, ' ');
      say(`  ${rec.name} 出口IP: ${ip}`);
      results.push({ instance: rec.name, kind: 'exit-ip', value: ip });
    }
    // 先准备空白标签页，再并发导航；每个标签页有自己的 CDP 连接和事件列表。
    await allFinished(o.urls.slice(1).map(async (_u, idx) => {
      const response = await fetch(`http://127.0.0.1:${rec.port}/json/new?about:blank`, {
        method: 'PUT', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`${name}: 创建标签页失败 (${response.status})`);
      tabs[idx + 1] = await attachCdp(rec.port, await response.json());
    }));
    await allFinished(o.urls.map((u, idx) => visitTab(rec, tabs[idx], u, idx)));
  } finally {
    for (const tab of tabs) tab?.close();
  }
}

(async () => {
  if (!o.json) {
    say(`API      = ${o.api}`);
    say(`URLs     = ${o.urls.join(', ')}`);
    say(`实例数   = ${o.count}   每实例每URL访问 = ${o.repeat}   停留 = ${o.hold}s   interact=${o.interact} clicks=${o.clicks} checkIp=${o.checkIp} keep=${o.keep} retry=${o.retry} waitLoad=${o.waitLoad} settleAds=${o.settleAds}`);
    say(`拟真强化 = referer=${o.referer}  reuseProfile=${o.reuseProfile}  swiftshader=${o.swiftshader}`);
    say(`代理     = ${o.proxy || '（直连）'}  proxyId=${o.proxyId || '空'}`);
    say(`指纹     = seed=${o.seed}+i  lang=${o.lang}  tz=${o.timezone}  window=${o.window}  hw=${o.hw}${o.ua ? `  ua=${o.ua.slice(0, 40)}…` : ''}`);
  }

  const health = await api('/api/health').catch(e => ({ status: 0, text: jerr(e) }));
  if (health.status !== 200) { say(`!! 无法连接 ${o.api} —— 确认 Ant-Browser 正在运行且 API 服务已开启。(${health.text})`); process.exit(1); }
  if (!o.json) say(`health   = ${health.text}`);

  if (!o.coreId) {
    const pj = await api('/api/profiles').catch(() => null);
    o.coreId = pj?.data?.items?.[0]?.coreId || '';
  }
  if (!o.coreId) { say('!! 无法自动探测 coreId（库里没有现成 profile），请用 --core-id 指定'); process.exit(1); }
  if (!o.json) say(`coreId   = ${o.coreId}`);

  try {
    runningTasks = allFinished(Array.from({ length: o.count }, (_, idx) => runProfile(idx + 1)));
    await runningTasks;
  } finally {
    await cleanup();
  }

  if (o.json) console.log(JSON.stringify({ api: o.api, urls: o.urls, config: { count: o.count, repeat: o.repeat, hold: o.hold, interact: o.interact, clicks: o.clicks, floatClick: o.floatClick, waitLoad: o.waitLoad, settleAds: o.settleAds, settleMax: o.settleMax, proxy: o.proxy, proxyId: o.proxyId, coreId: o.coreId, referer: o.referer, reuseProfile: o.reuseProfile, swiftshader: o.swiftshader }, results }, null, 2));
  else say('--- 完成 ---');
})().catch(e => { console.error(`!! ${jerr(e)}`); process.exitCode = 1; });
