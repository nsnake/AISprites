# Node 网页客户端

对照 ESP32 固件的功能做的网页端：连状态服务端的 `/ws`，把会话状态画成一个 128×64 的面板，
和 OLED 上看到的是同一张图。

零依赖，只用 Node 22+ 的内置模块（`http` / `WebSocket` / `fs`）。不需要 `npm install`。

## 文件

| 文件 | 作用 |
|---|---|
| `web_client.js` | 订阅服务端 `/ws` + 提供 `public/` 静态服务 + SSE 转发 |
| `public/index.html` | 页面：面板、连接状态、会话列表、原始消息流 |
| `public/app.js` | 会话表语义 + 面板渲染（`sessions.h` / `display.h` 的移植） |
| `public/icons.js` | 退役程序化图标的移植（claude 套是 `gen_icons.py` 参考实现的逐函数 JS 移植）——只作位图加载前 / 失败时的回退 |
| `public/img/` | 运行时加载的导入位图，与固件同一批素材：`claudecode/`（claude，PNG）、`codebuddy/`（JPG） |
| `public/snd/` | 状态提示音（Mixkit 免费音效）：`success.mp3`「Correct answer tone」、`error.mp3`「Wrong answer fail notification」 |
| `tools/check_icons.js` | claude 位图与真实 `icons.h` 逐字节比对；codebuddy 数组做结构校验 |

## 运行

```bash
# 默认连本机 :3000，页面起在 :8991
node web_client.js

# 指定服务端与端口
node web_client.js --port 8991 --server 192.168.3.201 --server-port 3000

# 打开页面
#   http://127.0.0.1:8991/
```

参数：`--port`（页面端口，默认 8991）、`--server` / `--server-port`（状态服务端，默认
`127.0.0.1:3000`）、`--help`。退出码：0 成功 / 1 传输失败 / 2 参数非法。

测试时用隔离的服务端实例，别动生产 :3000：

```bash
# Perl 侧
perl server.pl --port 3991 --udp-port 8091 --socket /tmp/playcat-test.sock

# Node 侧
node web_client.js --port 8991 --server 127.0.0.1 --server-port 3991
```

## 提示音

会话**切换进入** `success` / `error` 时各播一个提示音（别名如 `ok` / `failed` 经 `ALIASES`
归一后同样生效）。规则：

- 只在**实时事件**的状态切换时触发；页面加载 / SSE 重连收到的 snapshot 不播（不重放历史）。
- 同一状态重复上报去重；`busy` / `ready` / `off`、以及会话一出生就在 `success` / `error` 的，
  都不响。
- 头部的 🔔 按钮开关声音，偏好存 `localStorage`（键 `snd`），刷新后保持；重新开启时播一次
  确认音。
- 浏览器自动播放策略：页面加载后要有过一次用户交互（点任意处，比如这个按钮）才会真正出声，
  之前 `play()` 静默失败、不影响页面其它功能。

换音效：直接替换 `public/snd/` 下的同名文件即可；要给别的状态（如 `alarm`）加音效，在
`app.js` 的 `SOUNDS` 表加一行 `[I.STATE_xxx]: 'snd/xxx.mp3'`。`web_client.js` 的
`CONTENT_TYPES` 已含 `.mp3` / `.wav` / `.ogg`。

## 与固件的对应关系

网页端刻意做成「另一块屏幕」，而不是「另一个视图」：

| 固件 | 网页端 | 说明 |
|---|---|---|
| `ws.h` | `web_client.js` 的 `subscribe()` | 都是纯传输。**不做任何会话选择**——服务端只记账转发，仲裁在显示端 |
| `sessions.h` | `app.js` 的 `SessionTable` | 8 槽上限、`off` 释放、`ready` 隐形占槽、满表驱逐隐形槽、focus = 最近活跃 |
| `display.h` | `app.js` 的 `drawScene()` | 图标尺寸（1–2→48px、3→40px、4–8→28px）、网格、2px 边距、焦点框 |
| `icons.h` | `public/img/`（同素材）+ `public/icons.js`（回退） | claude 与 codebuddy 两边都用导入位图（固件由 `gen_icons.py` 生成时导入，网页运行时加载，同一亮度阈值规则）；程序化套不再进 `icons.h`，只在网页作回退 |
| — | `public/index.html` 的消息流 / 会话详情 | 网页端独有。原始 WS 消息按时间倒序列出，点会话展开状态历史 |

**只有两处有意差异**：

1. **单会话字幕**。固件用 `u8g2_font_6x13_tr`、按 6px/字形近似居中；页面有真实字体，用
   `measureText` 精确居中。所以单会话场景的像素不比对（字幕那几个像素必然不同），只比对图标。
2. **`#freeze`**。URL hash 带 `freeze` 时所有动画锁定在第 0 帧，用于和 `preview.py`（静态渲染
   第 0 帧）做逐像素比对。正常浏览不需要。

另有一条**非差异的已知界限**：两边图标是同一批位图素材，但重采样器不同（PIL LANCZOS
vs 浏览器画布），边缘像素会差一步——和 codebuddy 时代一样，逐像素 e2e 对图标本身
不成立，比对做形状级即可。位图都是静态单帧，固件与网页都没有动画。

## 与固件同步发布

和 Perl / 固件是同一套状态语义，改状态要一起改：

- **状态枚举**：`sessions.h` 的 `SessionState`、`gen_icons.py` 的 `NUM_STATES`、
  `public/icons.js` 的 `STATE_*` 与 `buildFrames()` 的索引顺序、`app.js` 的 `ALIASES` /
  `STATE_NAMES`，五处对齐。
- **新状态名**：服务端不校验状态名（校验在 `Client.pm` 的 send 分支），所以新状态服务端会
  直接广播。页面侧 `ALIASES` 里加一条别名即可识别；不加则归一为 `STATE_UNKNOWN`，画成转动
  齿轮——和固件收到不认识的状态名时的回退一致。
- **新 editor 图标集**：位图放进 `素材/<套装>/*`（`gen_icons.py` 的 `ART_SETS` 加条目、
  `python3 tools/gen_icons.py > icons.h` 重新生成），网页侧把同一批图拷到
  `public/img/<套装>/`，`app.js` 的 `ART_SETS` 加一个条目（编辑器名 → 目录 +
  扩展名）即可；程序化回退套在 `icons.js` 里按 editor 扩展（`iconsForSize()` 同理）。
- **动画周期**：`gen_icons.py` 的 `FRAME_MS` 与 `public/icons.js` 的 `FRAME_MS` 要一致
  （导入的位图是静态单帧，没有动画周期）。

## 验证

### 1. 图标结构校验（无需任何运行环境）

```bash
node tools/check_icons.js
```

解析真实的 `ESP32/esp32s3_ai_status_display/icons.h`：两套导入位图集（claude、
codebuddy）都做结构校验——每个数组在位、单帧、字节数与尺寸匹配。位图无法逐字节
比对（浏览器画布与 PIL 的重采样在边缘像素上差一步），固件侧另有
`check_layout.cpp` 覆盖布局。成功输出 `ALL CHECKS PASSED`——这行**不是最后打印的**，
后面还跟一行汇总，判断结果看退出码。默认自己找固件目录，也可以显式传路径：

```bash
node tools/check_icons.js /path/to/icons.h
```

### 2. 像素级 e2e（需要服务端 + 网页客户端 + Chrome）

仓库里没有这个脚本（它依赖 CDP 驱动的 headless Chrome，不适合作为交付物），
做法是：起隔离服务端和网页客户端，用 `tools/preview.py` 渲染同一场景，
把页面 canvas 和 preview PNG 逐像素比对：

- 1–4 会话、8 会话五个网格场景，两侧 **逐像素一致**（单会话字幕除外）。
- 注入用 `client.pl --mode send`。注意两点陷阱（下节）。

### 3. 手动注入

```bash
echo '{"session_id":"s1"}' | perl client.pl --mode send --state busy \
  --socket /tmp/playcat-test.sock
```

## 容易踩的坑

**`client.pl` 只能发适配器认识的 8 个状态。** `Client.pm` 的 send 分支按 Claude 适配器的
状态表校验（`thinking, busy, success, error, alarm, off, ready, idle`），别的名字会被拒。
要注入这 8 个之外的状态，绕过 `client.pl`，直接往服务端的 UDP 监听口发原始 datagram：

```js
const s = require('dgram').createSocket('udp4');
s.bind(0, '127.0.0.1', () => {
  s.send(Buffer.from(JSON.stringify({
    editor: 'codebuddy', state: 'some-new-state', source: 'manual',
    seq: 1, ts: Date.now(), session_id: 's6'
  })), 8091, '127.0.0.1', () => s.close());
});
```

服务端**不校验状态名**，只要求 JSON 里有 `state`。注意键序：固件的 JSON 扫描器依赖稳定键序，
`JSON.stringify` 的默认键序与 `JSON::XS->canonical` 一致，所以这里直接序列化即可。

**Node 的 `net.connect` 连不上 Unix datagram socket。** `EPROTOTYPE`。Node 的 `dgram` 也不支持
AF_UNIX（`unix_dgram` 会被拒绝，只接受 `udp4` / `udp6`）。要走 Unix socket 就只能用 Perl 侧的
`client.pl`；要走 Node 就用上面的 UDP 通道。

**`client.pl` 的 editor 恒为 `claude`。** 要在场景里出现 codebuddy 图标，必须走原始 datagram
并在消息体里带 `editor`。

**测试实例的会话表会残留。** `client.pl --state off` 只释放服务端认为该会话持有的槽位——
别的来源（探针、上一轮崩溃）留下的会话不在 `client.pl` 的认知里，清不掉。清表要先从 `/ws`
快照里拿到真实的 session_id 列表，再逐个发 `off`。否则 8 槽被残留占满时，新会话被服务端的
`--max-sessions` 挡掉，看起来像「消息没广播」。

**keepalive 不能用 WS ping。** Node 的全局 `WebSocket` 没有 `ping()`（调了会崩进程）。
发空文本帧即可——服务端把任何消息当流量，和 `ws_client.pl` 的做法一致。每 20s 一次，
短于常见 NAT 超时，主要作用是兜 TCP 半开（数据单向流，内核不会自己发现对端没了）。

**改服务端先起隔离实例。** 生产 `:3000` 常驻在跑。`pkill -f server.pl` 会连带杀掉生产实例，
用 PID 精确停测试实例。测试实例被 kill 后 `/tmp/playcat-test*.sock` 会残留，下次起实例可能
因路径占用绑定失败。
