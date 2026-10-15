# 页面等待参数

需要 Node.js 22 或更高版本及已启动的 Ant Launch API。

## 多实例、多标签并行

`--count` 个 profile 并行启动和访问。每个 profile 为每个 `--url` 打开独立标签页，并行导航；加载、停留及请求统计分别计算。`--repeat` 在对应标签页内依次重复访问，不会每轮新增标签页。

以下命令创建 3 个 profile，每个打开 2 个标签页，共 6 个目标标签页：

```sh
node work/ant-batch-visit.mjs \
  --url 'https://example.com' \
  --url 'https://example.org' \
  --count 3 --hold 12 --no-proxy
```

并行表示各任务可以重叠执行，实际加载速度受浏览器、网络和机器资源影响。所有任务结束后统一清理本次创建的 profile；加 `--keep` 保留窗口。Ctrl-C 会停止后续访问轮次，等待当前任务收尾后清理。

JSON 结果包含 `instance`、`tab` 和 `targetId`，用于区分实例与标签页。结果按完成顺序输出；`--json` 的运行日志写入 stderr，stdout 为 JSON。

常规访问：最多等 15 秒加载完成，然后额外停留 12 秒。

```sh
node work/ant-batch-visit.mjs --url https://example.com --wait-load 15 --hold 12
```

采集请求：先等加载，再停留 18 秒，之后等待连续 3 秒无新请求；最后这个阶段最多 30 秒。

```sh
node work/ant-batch-visit.mjs --url https://example.com --capture --wait-load 15 --hold 18 --settle-ads 3 --settle-max 30
```

- `--wait-load` 默认 15 秒，设为 0 关闭。加载超时后仍继续额外停留。
- `--hold` 默认 8 秒。
- `--settle-ads` 默认 0（关闭）。请求采集（CDP）现已始终开启，`--capture` 仅保留兼容旧命令。
- `--settle-max` 默认 30 秒，只限制请求安静等待阶段，不是整个访问的总超时。
- 安静窗口观察所有新请求，包括重复 URL；不代表所有在途请求已经结束，也不保证广告展示成功。
- 结果的 `loadState` 为 `off`、`complete`、`timeout` 或 `error`；`settleState` 为 `off`、`quiet` 或 `timeout`，`settleMs` 为该阶段耗时。

## 拟人鼠标交互（默认开启）

加载完成后，在 `--hold` 停留期间模拟真人浏览（移植自 vids 项目的贝塞尔轨迹实现，经 CDP `Input` 通道派发 isTrusted 原生事件）：微移、视线移动、平滑滚动（划动）、停留阅读，并按 `--clicks`（默认 `auto`：连点至连续 2 次点击无新广告为止，上限 6 次）点击页面。每次点击前先检测**漂浮广告**（fixed/高 z-index 的广告 iframe、含广告类名或创意文案的浮层，如 in-page push 横幅），命中则点击其中心（计入 `floatClicks`），未命中则点击页面中部随机点。每次点击可拉起 popunder / interstitial 广告（弹窗计入 `popups`）；实测同一页面连点可依次触发多个广告。交互总时长不超过 `--hold`，加载等待与安静窗口逻辑不变。

**前台串行**：弹窗只在前台（可见）标签触发——后台标签的点击不会弹出广告（广告脚本按 `document.visibilityState` 门控；实测：后台标签 2 次点击 0 弹窗，`bringToFront` 置前台后即弹出）。因此多标签/多实例时，交互阶段按队列逐个将标签置前台后执行（加载仍并行），总交互时长约为各访问 `--hold` 之和；`--hold 0` 或 `--no-interact` 不受影响。

```sh
node work/ant-batch-visit.mjs --url https://example.com --hold 12
node work/ant-batch-visit.mjs --url https://example.com --hold 12 --no-interact
```

- 结果中 `clicks` / `scrolls` 为该次访问实际执行的点击与滚动次数，控制台行显示 `act=Nc/Ns`；`floatClicks` 为命中的漂浮广告点击次数（行显示 `float=N`）。
- 漂浮广告检测点击默认开启（`--no-float` 关闭）：覆盖 in-page push / 浮层横幅等创意，命中时优先点击广告元素中心。
- `--clicks <n|auto>`：`auto`（默认）连点至**连续 2 次点击无新广告**（无弹窗且无广告请求）为止，上限 6 次；也可指定固定次数（0=不点击）。点击间隔 4~7 秒，需用 `--hold` 留足预算（auto 模式建议 `--hold 16` 以上）。
- `--no-interact` 关闭交互（纯停留）；`--hold 0` 时同样不执行。

## 真实访问拟真增强

1. **来源伪装（`--referer <url|auto|none>`，默认 `auto`）**：
   - 自动分析目标 URL，生成逼真的搜索引擎来路（如 `https://www.google.com/search?q=...`）或社媒中转（Twitter / Bing / HackerNews）。
   - 通过 CDP `Page.navigate` 原生 `referrer` 字段与 HTTP 请求头双重设置，使页内 `document.referrer` 与服务器网关日志完全匹配，解决直接访问（Direct / No-Referrer）的典型爬虫特征。
   - 使用 `--no-referer` 可关闭该行为。

2. **无 GPU 环境软解兼容（`--swiftshader`，默认开启）**：
   - 针对 Linux/WSL/云主机无实体 GPU 驱动环境，注入 `--enable-unsafe-swiftshader`、`--enable-webgl` 和 `--ignore-gpu-blocklist`，消除 Chromium 对 SwiftShader 软解废弃的底层报错，保证 WebGL 上下文能够稳定初始化。

3. **Profile 历史痕迹沉淀（`--reuse-profile`）**：
   - 默认模式下批处理结束后会清空并删除临时 Profile。
   - 启用 `--reuse-profile` 可保留并复用同名前缀的已有 Profile，使浏览器保留历史 Cookie、LocalStorage 与站点生态痕迹，避免每次全量新建导致的“纯净沙箱”机器特征。

本地等待逻辑测试（模拟 CDP 状态及请求事件，不启动浏览器）：

```sh
node --test work/visit-waits.test.mjs
node --test work/human-mouse.test.mjs
node --test work/parallel-visits.test.mjs
```

