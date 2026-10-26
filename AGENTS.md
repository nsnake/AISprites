# AGENTS.md — Playcat::AI::Sprites

把 AI 编辑器（Claude Code / CodeBuddy Code 等）的会话状态实时推送到 ESP32-S3 的 SSD1306 OLED。
Perl 侧收 hook 事件，固件侧维护会话表并画图标。Node 网页客户端是同一套语义的
「第二块屏幕」，在浏览器里画出和 OLED 一致的面板。完整说明见 README.md 与
doc/项目说明文档.md（部署配置与状态链路的逐段解读）。

## 布局

```
Perl/                        # 状态收集与广播（Perl 5.40+ / Mojolicious / JSON::XS）
  server.pl                  # 11 行 wrapper → Server->run
  client.pl                  # 11 行 wrapper → Client->run（hook 调用它）
  aisprites.json             # 服务端/客户端共享配置：端口、传输（本机 UDP 7788 + WS 3000）
  aisprites.json.example     # 配置模板，完整键位示例
  lib/Playcat/AI/Sprites/
    Server.pm                # datagram → WebSocket 转发，会话记账
    Client.pm                # 读 stdin、推断状态、发 datagram
    Config.pm                # 配置文件加载（--config / 环境变量 / 脚本目录 / 用户级）
    Editor.pm                # 编辑器适配器注册表
    Editor/Claude.pm         # Claude Code hook 事件 → 状态
    Editor/CodeBuddy.pm      # CodeBuddy Code hook 事件 → 状态
Node/                        # 网页客户端（零依赖，Node 22+ 内置模块）
  web_client.js              # 订阅 /ws + 静态服务 + SSE 转发（纯传输）
  public/index.html          # 页面：面板 + 连接状态 + 会话列表 + 消息流
  public/app.js              # sessions.h / display.h 的 JS 移植（会话表 + 渲染）
  public/icons.js            # 程序化图标绘制，位图加载失败时的网页回退
  public/img/                # 网页端运行时加载的编辑器位图（claudecode / codebuddy）
  public/snd/                # 状态提示音（切换到 success/error 时播，Mixkit 免费音效）
  tools/check_icons.js       # 两套导入位图集与 icons.h 做结构校验（在位、单帧、尺寸对）
ESP32/esp32s3_ai_status_display/
  esp32s3_ai_status_display.ino  # 114 行粘合层：WiFi + WS + display
  sessions.h                # 8 槽会话表（状态枚举、槽位分配）
  display.h                 # SSD1306 布局与绘制（U8g2）
  ws.h                      # 手写 RFC 6455 客户端（仅依赖 WiFiClient）
  icons.h                   # 【生成文件】改图标必须重新生成，不要手改
  Animation/                # GIF 原始素材，当前构建不引用
  tools/
    gen_icons.py            # 生成 icons.h（两套图标都从素材导入，需 Pillow）
    preview.py              # 无 Arduino 环境时渲染整屏 PNG
    check_layout.cpp        # 编译真实的 sessions.h + icons.h 做几何断言
    ws_roundtrip.py         # WebSocket 协议往返测试
    host_shim/Arduino.h     # 仅给上面两个 host 测试用的 Arduino 替身
doc/                        # overview.md（设计/实测/陷阱清单）、项目说明文档.md（部署与链路解读）、待确认.md
素材/                        # 编辑器图标源图（claudecode/*.png、codebuddy/*.jpg，固件与网页端同源）
Claudeset/settings.json     # Claude Code 的 hook 注册示例（7 个事件，client.pl 路径要改成实际安装路径）
CodebuddySet/settings.json  # CodeBuddy Code 的 hook 注册示例（9 个事件，命令带 --editor codebuddy）
README.md                   # 使用说明书：服务端 + Node 网页客户端的安装与使用
```

**没有 git 仓库。** 改动没有 diff 可看，也没有 CI；「改完跑过」完全靠手动执行下面的命令。

## 常用命令

```bash
# --- 服务端（生产实例常驻 :3000，改它要小心）---
cd Perl && perl server.pl                 # WS :3000 + UDP datagram + unix socket
# 端口先读 aisprites.json（本机 UDP 7788），优先级：命令行 > 配置文件 > 内置默认（UDP 8080）
perl server.pl --port 3991 --udp-port 8091 --socket /tmp/playcat-test.sock   # 测试实例

# --- Node 网页客户端（零依赖，Node 22+；也是看数据流的排障工具）---
cd Node && node web_client.js                                       # :8991 → 127.0.0.1:3000
node web_client.js --port 8991 --server 127.0.0.1 --server-port 3991  # 订阅测试实例
# 浏览器开 http://127.0.0.1:8991 ，页面自带连接状态 + 会话列表 + 消息流
node tools/check_icons.js                                           # 图标结构校验（对照 icons.h）

# --- 手动注入状态（不经过编辑器）---
echo '{"session_id":"s1"}' | perl client.pl --mode send --state busy --socket /tmp/playcat-test.sock
perl client.pl --mode send --state busy   # 本机：传输走 aisprites.json 的 client 段（UDP 7788）
# 不带 session_id 时服务端补固定 id __manual__
# 注意：--state 只认当前 --editor 适配器的状态表（8 个状态，claude / codebuddy 一致）。
# 要注入别的状态，绕过 client.pl 直接发原始 datagram（见 Node/README.md）

# --- 固件 host 验证（无需 Arduino / ESP32 / 服务端）---
cd ESP32/esp32s3_ai_status_display
python3 tools/gen_icons.py > icons.h                              # 改了图标/角标后必跑
g++ -std=c++17 -I. -Itools/host_shim -o /tmp/check tools/check_layout.cpp && /tmp/check
python3 tools/preview.py --scene 4 --out /tmp/s4.png              # N=1..8 整屏
python3 tools/preview.py --sheet --out /tmp/sheet.png             # 全图标逐帧
python3 tools/ws_roundtrip.py                                     # 需 websocket-client
```

## 测试

**没有任何自动化测试**（无 `.t`、无 pytest、无 CI、无 Makefile，也没有 git 仓库可供 diff）。三个手写工具是全部手段：

- `check_layout.cpp` — 编译**真实的** `sessions.h`/`icons.h`，断言图标不出界、焦点框留白 ≥2px、网格对称、动画帧步长正确、会话表语义（8 槽上限、`off` 释放、`ready` 隐形、满表驱逐隐形槽）。失败时 `FAIL: ...` 并 exit 1；全部通过时输出 `ALL CHECKS PASSED`——注意这行**不是最后打印的**，后面还跟着 `lifecycle:` 和 `session table:` 两行（`main()` 先跑布局检查，再跑会话表检查）。判断结果看退出码，不要只 grep 那一行。
- `preview.py` — 视觉检查，靠人看 PNG。图标和布局与固件逐像素一致；**只有文字是近似**的（PNG 用 5px 字形表，固件按 6px 居中，会偏 1–2px）。
- `ws_roundtrip.py` — 名义上测固件解析，**实际只测协议契约**：它跑一个 Python WS 服务端 + 一个 Python 客户端，**根本不执行固件的 C++**。`ws.h` 在 host 上零覆盖。

固件唯一的真编译要靠 Arduino IDE / PlatformIO，本机没有这个工具链。仓库里也没有 `platformio.ini`——依赖只有 `.ino` 头部注释提到的 U8g2（Library Manager）。

`display.h` 不在 `check_layout.cpp` 的编译范围内（它只编 `sessions.h` + `icons.h`），本机验证 `display.h` 的办法是临时 stub：写一个只有 `begin/setFont/setDrawColor/clearBuffer/sendBuffer/drawStr/drawXBM/drawFrame` 的 `U8g2lib.h` 和带 Arduino `String` 语义的 `Arduino.h`（`U8G2_R0`、`u8g2_font_6x13_tr` 也要给定义），`g++ -std=c++17 -I<stub目录> -I.` 编一个 include `display.h` 的 .cpp。2026-10-23 靠这个抓到了 `toEditor` 是 private、`&BADGE_CLAUDE` 是指针类型错两个从来没编译过的 bug——改 `display.h` 后务必这样过一遍。

## 架构约束（违反会出真 bug）

**hook 客户端绝不能拖慢编辑器。** `--mode hook` 退出码恒为 0，失败静默返回；stdout 必须为空（Claude Code 会把 stdout 当决策 JSON 解析）；所有 `timeout: 2`。SessionEnd 只有 1.5s 共享预算，只发一条即时 datagram，不要在里面做慢操作。排障把写入放主链路之后（`--debug` 落盘 `~/.playcat-ai-sprites/client-debug.jsonl`，见 `Client.pm::dump_debug`）。

**服务端只记账转发，不做仲裁。** 「哪些会话上屏」完全由显示端决定。不要在服务端加「选当前会话」的逻辑（旧版有过，已删）。WS 订阅建立时服务端推一次**全量快照**（`type:snapshot`，`build_snapshot`），显示端据此整表重建，断线重连不丢会话。`web_client.js` 同样只是传输：它把 WS 帧原样转成 SSE，会话表在浏览器侧的 `app.js` 里。

**协议只用 `state` 字符串，不要加字段。** 消息形如 `{"editor":"claude","type":"state","state":"busy","source":"hook","session_id":"…","seq":3,"ts":…}`，显示端取 `state` / `session_id` / `editor` 三个字段。`Client.pm` 组消息、`Server.pm` 解析、固件 `ws.h` 的手写 JSON 扫描器都围绕 `state` 转。加字段要改三处解析，而且固件扫描器见 `null` 会把后一个键值误当它的值——`editor` 缺省时是**整键省略**，不是发 `"editor":null`。

**配置文件只承载传输选项。** `aisprites.json`（`Config.pm` 加载，查找顺序：`--config` → 环境变量 `PLAYCAT_AI_SPRITES_CONFIG` → 脚本所在目录 → `~/.playcat-ai-sprites/config.json`；键名与命令行长选项一致、`-` 写成 `_`，分 `server` / `client` 两段）只放传输选项，`--mode` / `--state` 这类单次调用语义**不进**配置文件。配置坏了服务端直接拒绝启动（长驻进程带错配置起在默认端口更难排查），客户端只警告并回退内置默认值（保住 hook exit 0 语义）。

**Perl 与固件必须同步发布。** 旧固件收到不认识的状态名会回退到 `STATE_UNKNOWN`（画成转动的齿轮）。改状态语义要两侧一起改。Node 网页端同理：`public/icons.js` 的 `STATE_*` 与 `FRAME_MS`、`app.js` 的 `ALIASES` / `STATE_NAMES` 必须同步更新。服务端不校验状态名（校验只在 `Client.pm` 的 send 分支），新状态会被直接广播。

**状态枚举与图标表必须对齐。** `sessions.h` 的 `SessionState`、`gen_icons.py` 的 `NUM_STATES`（**硬编码字面量 9**，不是从列表推导）、`ICONS_<size>[NUM_STATES]` 与 `ICONS_<size>_CODEBUDDY[NUM_STATES]` 的索引顺序、`display.h::stateName`、`public/icons.js` 的 `buildFrames()` 索引，五处要一起改。`gen_icons.py` 不会替你检查，`check_icons.js` 只做结构校验（数组在、单帧、尺寸对），也不检查枚举对齐。两套图标都是**导入位图**（claude ← `素材/claudecode/*.png`，codebuddy ← `素材/codebuddy/*.jpg`，生成需 Pillow），网页端 `app.js` 运行时加载同一批图（`public/img/<套装>/`）；程序化绘制那套已退役，`icons.js` 只作位图加载失败时的网页回退。每个编辑器一整套图标，未知 `editor` 回落 claude 那套；要给新编辑器加图标只需改 `sessions.h` 的 `EditorId` + `gen_icons.py`，不动协议和服务端。

**会话表不做超时清除。** `sessions.h` 开头写明这是 deliberate。僵死会话靠服务端重启清空快照，不要在固件里加过期扫描。网页端的 `app.js` 同样无过期、无陈旧扫描。

## 容易踩的坑

**CPU 锁死 100%。** `Mojo::Reactor` 的 `io()` 默认同时监听读写。datagram socket 的发送缓冲几乎永不满，写事件永久就绪，回调每秒被调十几万次。拿到 socket 后必须 `$reactor->watch($sock, 1, 0)` 只保留读。

**连接频繁 1006 断开。** Mojolicious 的 `inactivity_timeout` 默认服务端 30s / 客户端 40s，对 WS 长连接订阅是错的——没状态事件的空档会被当死连接掐断。服务端 `$daemon->inactivity_timeout(0)`，订阅端自己发心跳兜 TCP 半开（Node `web_client.js` 每 20s 发一个空文本帧）。

**访问器不能叫 `sessions`。** `Mojolicious::Controller` 有同名方法，覆盖它会让渲染进 exception 模版并使 reactor 空转。用 `session_table`。

**Perl 里 `[]` 是真值。** Claude Code「无后台任务」时发显式空数组而非缺省，Stop 事件必须按数组长度判断 `background_tasks` **和** `session_crons`，否则正常结束也被判成 busy。

**PowerShell 的 `>` 会写成 UTF-16。** Windows 上重新生成 icons.h 要用 `cmd /c "python tools\gen_icons.py > icons.h"`，不要在 PowerShell 里重定向。

**UTF-8 二次编码。** debug 转储先 `Encode::decode` 成字符再交给 `:encoding(UTF-8)` 文件句柄落盘；对已解码字符再调 `->utf8->encode` 会变成乱码。

**改服务端先起测试实例。** 生产 `server.pl` 常驻在跑（健康页 `curl http://127.0.0.1:3000/`）。验证用 `--port 3991` 之类的隔离端口和独立 socket 路径。`pkill -f server.pl` 会连带杀掉生产实例，用 PID 精确停测试实例。

**测试实例的 socket 文件要手清。** 服务端只在启动时清残留 socket；测试实例被 kill 后 `/tmp/playcat-test*.sock` 会留下，下次起实例可能因路径占用绑定失败。

**改服务端的标准流程**：起隔离实例 → 起一个 Node 网页客户端订阅它（浏览器页里有消息流）→ 用 `client.pl --mode send --state <状态>` 注入事件 → 看页面收到什么。先清表（给每个 session_id 发 `off`）再测新场景，否则上一轮的 8 个会话会让新会话被上限丢弃，看起来像「消息没广播」。

## 代码风格

Perl：统一 `use v5.40`（隐含 strict，不再写 `use strict`）。`signatures` 按文件二分——`Client.pm`/`Config.pm`/`Editor.pm`/`Claude.pm`/`CodeBuddy.pm` 用 `sub foo($a,$b)`，`Server.pm` 用 `my ($a,$b) = @_`，改文件时沿用该文件的既有风格。纯 snake_case，私有子程序 `_` 前缀，常量 `use constant {}` 全大写。**业务注释写中文，usage 帮助与 die/warn 消息写英文**（面向用户的消息是英文）。`die` 只用于启动期失败且消息以 `\n` 结尾，运行期可忽略问题用 `warn`，`eval {}` 只包 JSON/socket 这类边界操作并静默降级。JSON 统一 `JSON::XS->utf8->canonical`（固件解析依赖稳定键序）。退出码：0 成功 / 1 传输失败 / 2 参数非法。

固件 C++：单头文件职责单一，注释全英文，`constexpr` 常量放开头。`display.h` 与 `ws.h` 各自有一份 `extractString`（有意重复，避免跨头依赖）。

文档与交流一律中文；`doc/待确认.md` 里的问题确认后要删条目不留档。

## 状态语义

8 个状态：`ready` / `off` / `idle` / `thinking` / `busy` / `success` / `error` / `alarm`（claude 与 codebuddy 的状态表一致）。

事件 → 状态（`Editor/Claude.pm` 的 `EVENT_TO_STATE`；CodeBuddy 同构，`PostToolUseFailure` 直接映射 `error`）：

| 事件 | 状态 |
|------|------|
| SessionStart | `ready` |
| SessionEnd | `off` |
| UserPromptSubmit / UserPromptExpansion / PostToolUse / PostToolBatch / SubagentStart / SubagentStop / TaskCompleted / PostCompact | `thinking` |
| PreToolUse / TaskCreated / PreCompact | `busy` |
| Stop | `success`（特判见下） |

Notification 按 `notification_type` 细分：`permission_prompt` / `elicitation_dialog` → `alarm`，`idle_prompt` → `idle`，`auth_success` → `success`，`elicitation_complete` / `elicitation_response` → `thinking`，未知类型默认 `alarm`。

`infer_state` 三条特判：`--state` 显式传入直接采用；Stop 的 `background_tasks` 或 `session_crons` 非空 → `busy`（本轮还没真正结束）；PostToolUse 的 `tool_response.is_error` / `tool_is_error` 为真 → `error`。

会话生命周期三态分离，`ready`/`idle`/`off` 不可混用：

| 事件 | 状态 | 显示端行为 |
|---|---|---|
| SessionStart | `ready` | 占槽位，不画图标（隐形） |
| idle 通知 | `idle` | 保留槽位，画呼吸点待机图（会话仍存活） |
| SessionEnd | `off` | 释放槽位，删图标（唯一能清会话的事件） |

同一 `session_id` 的 SessionStart 会发多次（startup/resume/clear/compact/fork）。服务端有**不降级守卫**（`Server.pm::handle_message`）：收到 `ready` 时若该会话已处于 `thinking`/`busy`/`success`/`error`/`alarm`/`idle`，只更新记账、不广播（resume 打断 busy 会话时保持 busy）；`off` 不受限，无条件广播。

上限 8 槽，服务端 `--max-sessions`（默认 8，`0` = 不限）先挡，已有会话的更新不受限。调高**不会让屏幕多显示**——固件按 4×2 网格，自己的 8 槽上限不变，只影响记账（方便网页端等其它订阅者）。固件布局按**可见**会话数自适应：1–2 个 48×48、3 个 40×40、4–8 个 28×28（4×2）；隐形 `ready` 槽不参与计数、不抢焦点描边，满表时新会话优先驱逐隐形槽。只有焦点会话播动画，`success` / `idle` 都保留图标，只有 `off` 才删。

## 部署要点

- PC 端依赖：Perl 5.40+ / Mojolicious / JSON::XS。端口等选项写进 `Perl/aisprites.json`（模板见 `aisprites.json.example`），命令行参数可临时覆盖。
- 同机默认 Unix socket；跨机器或 Windows 用 UDP（Windows 无 Unix socket，服务端自动跳过 Unix listener，`--socket ''` 可在任何平台显式禁用；客户端配置 `"udp": true` 或 `--udp`，hook 命令无需再带传输参数）。
- 固件常量在 `.ino` 顶部：`WIFI_SSID`（默认 `Redmi_1008`）/ `SERVER_HOST`（默认 `192.168.3.201`）/ `SERVER_PORT`（3000）。接线（4 线硬件 SPI）：SCK=GPIO12 / MOSI=GPIO11 / CS=GPIO10 / DC=GPIO9 / RST=GPIO8，引脚定义在 `display.h` 顶部。
- `Claudeset/settings.json`（7 个 hook 事件）复制到 `C:\Users\<用户名>\.claude\settings.json`；`CodebuddySet/settings.json`（9 个事件，多 `PostToolUseFailure` / `PermissionRequest`）的 hooks 段合并进 `~/.codebuddy/settings.json` 或项目 `.codebuddy/settings.json`，改完必须在 `/hooks` 菜单里审查放行，未放行的 command hook 不会运行。两个模板里的 `client.pl` 路径都是 `e:/code/perl/aisprites/...`，部署要改成实际安装路径。
- 换机器部署：ESP32 的 `SERVER_HOST`、配置文件 `server` 段端口、客户端 `client.host`（客户端与服务端不同机时填服务端地址）要一起改。
- 烧录前先用 U8g2 hello world 确认接线；模块若是 SH1106 要换 `U8G2_SH1106_...` 构造，否则错位。
- GPIO0/3/45/46 是 strapping 引脚，不要用。
