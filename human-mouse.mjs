/**
 * human-mouse.mjs — 拟人鼠标交互（CDP 移植版）
 *
 * 移植自 /home/zm/vids/src/human-mouse.js（Playwright 版），改用裸 CDP
 * Input.dispatchMouseEvent 通道派发，事件仍是浏览器内核原生的 isTrusted 事件。
 *
 * 1. 三阶贝塞尔曲线 + 费茨法则步数 + S 型缓动模拟手部运动轨迹；
 * 2. 叠加生理微震颤与末端过冲回弹；
 * 3. 自然滚轮滚动（划动）与闲置游走；
 * 4. humanInteract：在给定秒数预算内执行一段浏览交互（微移/滚动/点击），
 *    供 ant-batch-visit.mjs 在 --hold 停留期间调用。
 */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 盒-穆勒变换：标准正态分布随机数 */
export function randomGaussian(mean = 0, stdev = 1) {
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2) * stdev + mean;
}

/** 三阶贝塞尔曲线插值 */
export function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** S 型缓动（加速 → 巡航 → 减速微调） */
export function humanEase(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 生成符合生物力学的人类鼠标移动路径点集合
 * @returns {Array<{x: number, y: number, delayMs: number}>}
 */
export function generateHumanPath(fromX, fromY, toX, toY, options = {}) {
  const dx = toX - fromX, dy = toY - fromY;
  const distance = Math.hypot(dx, dy);
  if (distance < 2) return [{ x: toX, y: toY, delayMs: 10 }];

  // 步数按费茨法则随距离动态计算，通常 12 ~ 45 步
  const baseSteps = Math.min(45, Math.max(12, Math.floor(Math.sqrt(distance) * 2.2)));
  const steps = baseSteps + Math.floor(randomGaussian(0, 2));

  // 随机两处控制点，模拟手腕偏摆弧线
  const normalX = -dy / distance, normalY = dx / distance;
  const side = Math.random() < 0.5 ? 1 : -1;
  const deviation = (options.deviation ?? Math.min(distance * 0.35, 60)) * side;
  const cp1Ratio = 0.25 + Math.random() * 0.2;
  const cp1Offset = deviation * (0.6 + Math.random() * 0.4);
  const cp1X = fromX + dx * cp1Ratio + normalX * cp1Offset;
  const cp1Y = fromY + dy * cp1Ratio + normalY * cp1Offset;
  const cp2Ratio = 0.65 + Math.random() * 0.2;
  const cp2Offset = deviation * (0.3 + Math.random() * 0.4);
  const cp2X = fromX + dx * cp2Ratio + normalX * cp2Offset;
  const cp2Y = fromY + dy * cp2Ratio + normalY * cp2Offset;

  // 末端过冲（50% 概率 2~5 像素过冲后回正）
  const hasOvershoot = options.overshoot !== false && distance > 80 && Math.random() < 0.6;
  const overshootDistance = hasOvershoot ? Math.min(distance * 0.05, 5) : 0;
  const targetX = hasOvershoot ? toX + (dx / distance) * overshootDistance : toX;
  const targetY = hasOvershoot ? toY + (dy / distance) * overshootDistance : toY;

  const tremorMag = options.tremorMagnitude ?? 1.0;
  const path = [];
  for (let i = 1; i <= steps; i += 1) {
    const rawT = i / steps;
    const t = humanEase(rawT);
    const curX = cubicBezier(fromX, cp1X, cp2X, targetX, t);
    const curY = cubicBezier(fromY, cp1Y, cp2Y, targetY, t);
    // 微震颤接近终点时收敛（手部紧张微调）
    const dampening = 1 - rawT * 0.7;
    const jitterX = randomGaussian(0, tremorMag * dampening);
    const jitterY = randomGaussian(0, tremorMag * dampening);
    // 中间巡航快 (≤8ms)，两头慢 (≤13ms)
    const speedFactor = 1 - Math.sin(rawT * Math.PI) * 0.6;
    const delay = Math.max(3, Math.round(8 * speedFactor + Math.random() * 5));
    path.push({
      x: Math.round((curX + jitterX) * 10) / 10,
      y: Math.round((curY + jitterY) * 10) / 10,
      delayMs: delay,
    });
  }
  if (hasOvershoot) {
    const last = path[path.length - 1];
    for (let j = 1; j <= 3; j += 1) {
      const ct = j / 3;
      path.push({
        x: Math.round((last.x + (toX - last.x) * ct) * 10) / 10,
        y: Math.round((last.y + (toY - last.y) * ct) * 10) / 10,
        delayMs: 12 + Math.floor(Math.random() * 8),
      });
    }
  }
  path.push({ x: toX, y: toY, delayMs: 8 });
  return path;
}

// ---------- CDP 通道 ----------
const posMap = new WeakMap(); // cdp 客户端 → 当前鼠标位置

export function getMousePos(cdp) {
  let pos = posMap.get(cdp);
  if (!pos) {
    pos = { x: 100 + Math.floor(Math.random() * 400), y: 100 + Math.floor(Math.random() * 300) };
    posMap.set(cdp, pos);
  }
  return pos;
}
export function setMousePos(cdp, x, y) { if (cdp) posMap.set(cdp, { x, y }); }

const dispatch = (cdp, params) => cdp.send('Input.dispatchMouseEvent', params);

/** 拟人轨迹移动（逐点派发 mouseMoved） */
export async function humanMouseMove(cdp, targetX, targetY, options = {}) {
  if (!cdp?.send) return;
  const from = getMousePos(cdp);
  const path = generateHumanPath(from.x, from.y, targetX, targetY, options);
  for (const p of path) {
    // 不等待应答：由 sleep 定速，慢应答不会拖长轨迹（事件顺序仍由 CDP 会话保证）
    dispatch(cdp, { type: 'mouseMoved', x: Math.round(p.x), y: Math.round(p.y), button: 'none', buttons: 0 }).catch(() => { });
    if (p.delayMs > 0) await sleep(p.delayMs);
  }
  setMousePos(cdp, targetX, targetY);
}

/** 拟人物理点击：移动 → 击键前停顿 → 按下 → 按压时长 → 抬起 → 余顿 */
export async function humanMouseClick(cdp, x, y, options = {}) {
  if (!cdp?.send) return false;
  await humanMouseMove(cdp, x, y, options);
  const button = options.button || 'left';
  await sleep(40 + Math.floor(Math.random() * 80));
  dispatch(cdp, { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button, buttons: 1, clickCount: 1 }).catch(() => { });
  await sleep(60 + Math.floor(Math.random() * 70));
  dispatch(cdp, { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button, buttons: 0, clickCount: 1 }).catch(() => { });
  await sleep(50 + Math.floor(Math.random() * 60));
  return true;
}

/** 拟人滚轮平滑滚动（加速度 + 阻尼递减）；deltaY 正为向下 */
export async function humanScroll(cdp, deltaY) {
  if (!cdp?.send) return;
  const pos = getMousePos(cdp);
  const ticks = Math.max(3, Math.min(8, Math.floor(Math.abs(deltaY) / 60)));
  const step = deltaY / ticks;
  for (let i = 1; i <= ticks; i += 1) {
    const ease = 1.3 - (i / ticks) * 0.5;
    dispatch(cdp, {
      type: 'mouseWheel', x: Math.round(pos.x), y: Math.round(pos.y),
      deltaX: 0, deltaY: Math.round(step * ease), button: 'none', buttons: 0,
    }).catch(() => { });
    await sleep(25 + Math.floor(Math.random() * 35));
  }
}

/** 闲置游走：手部偶发轻微挪动 5~20 像素 */
export async function humanIdleDrift(cdp) {
  if (!cdp?.send) return;
  const cur = getMousePos(cdp);
  await humanMouseMove(cdp, Math.max(20, cur.x + randomGaussian(0, 12)), Math.max(20, cur.y + randomGaussian(0, 8)), {
    deviation: 8, overshoot: false, tremorMagnitude: 0.6,
  });
}

// ---------- 交互驱动 ----------
async function viewportSize(cdp) {
  try {
    const r = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: 'JSON.stringify({w:innerWidth,h:innerHeight})' });
    const v = JSON.parse(r?.result?.value || '');
    if (v && v.w > 0 && v.h > 0) return v;
  } catch { }
  return { w: 1280, h: 800 };
}

/**
 * 检测视口内的漂浮广告元素（fixed/高 z-index 的广告 iframe、含广告类名或创意文案的浮层等），
 * 返回候选中心点列表（按 z-index 降序，最多 8 个）。仅静态扫描 DOM，不点击。
 */
export async function findFloatingAds(cdp) {
  if (!cdp?.send) return [];
  try {
    const r = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const ADSRC = /acscdn|adexchangerapid|adcash|popcash|doubleclick|googlesyndication|adsterra|propeller|monetag|rtmark/i;
      const HINT = /(^|[^a-z])(ad|ads|adv|advert|banner|popup|popunder|push|float|overlay|sponsor|promo)([^a-z]|$)/i;
      const TEXT = /block popups|advertisement|sponsored|install|download now|enjoy videos/i;
      const out = [];
      for (const el of document.querySelectorAll('div,iframe,ins,aside,section,a')) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 60 || rect.height < 30) continue;
        if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none' || +cs.opacity === 0) continue;
        const pos = cs.position;
        const z = parseInt(cs.zIndex, 10) || 0;
        const isIframe = el.tagName === 'IFRAME';
        const src = isIframe ? String(el.src || '') : '';
        const hint = String(el.id || '') + ' ' + String(el.className || '');
        const text = (el.textContent || '').slice(0, 150);
        const isAdSrc = ADSRC.test(src);
        const floating = pos === 'fixed' || (pos === 'absolute' && z >= 100);
        if (isAdSrc || (isIframe && pos === 'fixed' && z >= 100) || (floating && z >= 1000 && (HINT.test(hint) || TEXT.test(text)))) {
          out.push({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), w: Math.round(rect.width), h: Math.round(rect.height), z, tag: el.tagName, id: String(el.id || '').slice(0, 40), src: src.slice(0, 80) });
        }
      }
      out.sort((a, b) => b.z - a.z);
      return JSON.stringify(out.slice(0, 8));
    })()` });
    const list = JSON.parse(r?.result?.value || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

/**
 * 在 seconds 秒预算内执行一段拟人浏览交互：
 * 微移 → 视线停留 → 移动视线 → 下滚 → 阅读停留 → 多次点击（可触发 popunder/interstitial）→ 部分回滚。
 * clicks 为数字（固定次数）或 'auto'（自适应：连续 2 次点击无新广告即停，上限 6 次）；
 * hasNewAd(sinceIndex) 由调用方判定某次点击是否产生了新广告；
 * floatClick 默认开启：点击前检测漂浮广告（浮层创意）并优先点击，命中数计入 adClicks。
 * 每步先给出时长上界，剩余预算不足时不启动，保证总时长不超过预算；
 * isStopped() 返回 true（如 Ctrl-C）时提前结束。返回实际执行的 { actions, clicks, scrolls }。
 */
export async function humanInteract(cdp, seconds, options = {}) {
  const out = { actions: 0, clicks: 0, scrolls: 0, adClicks: 0 };
  if (!cdp?.send || !(seconds > 0)) return out;
  const isStopped = options.isStopped || (() => false);
  if (isStopped()) return out;
  const deadline = Date.now() + seconds * 1000;
  const left = () => deadline - Date.now();
  const step = async (estMs, fn) => {
    if (isStopped() || left() < estMs) return false;
    try { await fn(); out.actions++; return true; } catch { return false; }
  };
  const { w, h } = await viewportSize(cdp);
  const rand = (min, max) => min + Math.random() * (max - min);

  await step(350, () => humanIdleDrift(cdp));                                   // 手部微移
  const settlePause = Math.round(600 + Math.random() * 700);
  await step(settlePause, () => sleep(settlePause));                            // 视线停留
  await step(1300, () => humanMouseMove(cdp, rand(w * 0.15, w * 0.55), rand(h * 0.25, h * 0.5))); // 移动视线
  const down = Math.round(160 + Math.random() * 160);
  if (await step(500, () => humanScroll(cdp, down))) out.scrolls++;             // 向下滚动阅读
  const readPause = Math.round(800 + Math.random() * 1000);
  await step(readPause, () => sleep(readPause));                                // 阅读停留

  // 若预算非常充裕（如长停留大文章），在交互前模拟真实读者的二次视线扫读
  if (left() > 14000) {
    const extraDown = Math.round(180 + Math.random() * 200);
    if (await step(500, () => humanScroll(cdp, extraDown))) out.scrolls++;
    const scanPause = Math.round(700 + Math.random() * 900);
    await step(scanPause, () => sleep(scanPause));
    await step(900, () => humanMouseMove(cdp, rand(w * 0.2, w * 0.7), rand(h * 0.3, h * 0.6)));
  }

  // 多次点击：每次点击都可能拉起 popunder / interstitial（实测同页连点可依次触发多个广告）。
  // 每次点击前先检测漂浮广告（浮层/in-page push 创意），命中则点击其中心（计入 adClicks），
  // 否则点击页面中部随机点。clicks 为数字时固定次数；为 'auto' 时自适应——每次点击后观察
  // hasNewAd(sinceIndex)，连续 2 次点击未产生新广告（无弹窗且无广告请求）即停，上限 6 次（仍受预算约束）。
  const isAuto = options.clicks === 'auto';
  const maxClicks = isAuto ? 6 : Math.max(0, Math.floor(options.clicks ?? 1));
  const hasNewAd = options.hasNewAd || (() => true);
  const eventsLen = () => (Array.isArray(cdp.events) ? cdp.events.length : 0);
  const floatClick = options.floatClick !== false;
  let misses = 0;
  for (let k = 0; k < maxClicks; k++) {
    const mark = eventsLen();
    let targeted = false;
    if (!(await step(1750, async () => {
      const ads = floatClick ? await findFloatingAds(cdp) : [];
      if (ads.length) {
        targeted = true;
        await humanMouseClick(cdp, ads[0].x, ads[0].y);
      } else {
        await humanMouseClick(cdp, rand(w * 0.25, w * 0.5), rand(h * 0.35, h * 0.65));
      }
    }))) break;
    out.clicks++;
    if (targeted) out.adClicks++;
    const gap = Math.max(1000, Math.min(4000 + Math.random() * 3000, left() - 1900));
    await step(gap, () => sleep(gap));
    if (isAuto && k < maxClicks - 1) {
      misses = hasNewAd(mark) ? 0 : misses + 1;
      if (misses >= 2) break;
    }
  }

  // 点击交互收尾后：若仍有充裕预算（如 auto 提早收敛或大 hold），执行自然阅读延展而不是呆滞不动
  while (left() > 3200 && !isStopped()) {
    const scrollStep = Math.round(140 + Math.random() * 180);
    const dir = Math.random() < 0.75 ? 1 : -1;
    if (await step(450, () => humanScroll(cdp, scrollStep * dir))) out.scrolls++;
    const dwell = Math.min(left() - 900, Math.round(800 + Math.random() * 1200));
    if (dwell > 0) await step(dwell, () => sleep(dwell));
    await step(400, () => humanIdleDrift(cdp));
  }

  if (Math.random() < 0.5) {
    if (await step(500, () => humanScroll(cdp, -Math.round(down * 0.4)))) out.scrolls++; // 部分回滚
  }
  return out;
}
