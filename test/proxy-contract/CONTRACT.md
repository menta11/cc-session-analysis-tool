# cc-monitor 代理层契约

本文件是**语言无关**的契约定义。同一套契约必须同时被两个实现满足：

| 实现 | 位置 | 角色 |
|---|---|---|
| Node（vendored 参考实现） | `vendor/cc-monitor/proxy.js`（约 2.6k 行，逐字搬运、只读） | **黄金基准**（golden） |
| Rust | `src-tauri/target/release/proxy-standalone`（`cargo build --release --features standalone --bin proxy-standalone`） | 被测实现（SUT） |

契约测试（`test/proxy-contract/`）通过 **HTTP 黑盒**驱动两者：同一批用例、同一个假上游、同样的断言，
只换「怎么把被测服务（SUT, system under test）拉起来」。

> 为什么必须黑盒：`proxy.js` 的核心风险在「字节怎么过」——SSE 分帧、跨 chunk 的多字节字符、
> chunked 透传、状态码/头部透传。这些只有在真实 socket 上跑才作数，单元测试替不了。

---

## 1. SUT 必须接受的环境变量

| 变量 | 必填 | 语义 |
|---|---|---|
| `CC_MONITOR_PORT` | ✅ | 监听端口。测试每次分配空闲端口，保证并发用例不撞车 |
| `CC_MONITOR_TARGET` | ✅ | 上游 base URL，**优先级最高**。测试指向本地假上游 |
| `CC_MONITOR_LOOP_BYPASS` | ✅ | `=1` 时允许上游是 loopback（测试专用；生产下 loopback 上游视为死循环并拒绝启动） |
| `HOME` | ✅ | 家目录。实现必须从 `$HOME/.claude/settings.json`、`$HOME/.claude/cc-monitor-state.json` 取配置 |
| `CC_MONITOR_LOG_DIR` | 建议 | 日志目录。允许忽略 |
| `CC_MONITOR_DEBUG` | 建议 | `=0` 关调试 dump。允许忽略 |

实现必须在监听成功后让 `GET /status` 可访问；测试轮询该端点做就绪探测（上限 10s）。
若端口被占用，实现必须**报错退出**（非 0 退出码），不得静默换端口——否则测试会连到别的进程。

## 2. SUT 必须提供的可观测端点

除下表外，**任何** path/method 都必须走透传（见 §3）。

| 端点 | 响应 |
|---|---|
| `GET /status` | `200` + JSON（body 内容不限，只用于就绪探测） |
| `GET /config/baseurl` | `200` + JSON，字段见下 |
| `POST /config/baseurl` | body `{"action":"enable"\|"disable"}` → `200` + `{"ok":true,...}`；非法 action 或配置不可用 → `400` + `{"ok":false,"error":"<原因>"}` |

`GET /config/baseurl` 响应字段（键名必须一致，供 §4 优先级用例断言）：

```jsonc
{
  "monitoring": false,          // settings.json 当前是否指向本代理
  "current": null,              // settings.json 里的 ANTHROPIC_BASE_URL 当前值（无则 null）
  "previous": null,             // state.json 里记录的开监控前原值
  "originalUrl": "https://...", // 展示用：cc 原本的 URL
  "proxyUrl": "http://localhost:<port>",
  "directUrl": "https://...",   // ★ 解析出的真实上游（= resolveExplicitApiUrl() || 'https://api.anthropic.com'）
  "settingsPath": "$HOME/.claude/settings.json",
  "settingsKey": "env.ANTHROPIC_BASE_URL",
  "available": true,            // 是否能解析出真实上游（决定 dashboard 开关是否可点）
  "availableReason": null       // available=false 时给出人类可读原因，非空字符串
}
```

---

## 3. 透传契约（用例 C1–C11）

### C1 method + path
- `POST <SUT>/v1/messages` → 上游收到 `POST /v1/messages`
- 带 query 必须保留：`<SUT>/v1/messages?beta=1` → 上游 `/v1/messages?beta=1`
- 上游 base URL 带 path 前缀时**必须拼接**：`CC_MONITOR_TARGET=http://127.0.0.1:P/api`
  → 上游收到 `/api/v1/messages`（前缀去掉末尾 `/`，请求 path 原样接上）
- `GET` 等非 POST 方法同样透传（SUT 不得只放行 POST）

### C2 请求头
- 客户端**所有**请求头原样到达上游，`x-api-key`、`authorization`、`anthropic-version`、
  `content-type`、`accept`、`x-agent-id`、自定义头都必须存活；**不得**按名字白名单裁剪。
- 只有 `host` 被改写：等于上游主机名（不含端口）。
- **不得**注入/删除 `content-length`（body 长度不变时）。

### C3 请求体
- 请求体按原始字节透传，**不得**做 utf-8 解码再编码。
  用例用 `0x00..0xFF` 全字节序列（非法 utf-8）验证：上游收到的字节与客户端发出的完全一致。
- 长度用具体体量验证（如 256 KiB 随机字节），防止实现静默截断。

### C4 状态码
- 上游 `201 / 404 / 429 / 500` → 客户端看到**同一个**状态码，不得改写。

### C5 响应头
- 上游 `content-type`、自定义 `x-upstream`、`retry-after` → 客户端都能看到同值。

### C6 非 SSE 快速分流（**背压无关的流式**）
- 上游分 3 段写 body，段间等待「客户端已收到上一段」的信号后才写下一段。
- 断言：客户端最终收到**字节完全一致**的 body，**且**在收到第 1 段后上游才被放行写第 2 段
  （证明是流式转发，不是攒齐再发）。超时即失败。

### C7 SSE 字节保真（**本契约最关键的一条**）
- 上游返回 `content-type: text/event-stream`，body 为如下原始字节（含真正的多字节字符）：
  - 至少 3 个完整 event，`event:` + `data:` 组合，JSON 内含中文与 emoji
  - 其中**一个 event 用 `\r\n` 分隔、另一个用 `\n` 分隔**（CRLF 兼容）
  - 结尾含 `data: [DONE]`
- 上游把该字节流按**对抗性边界**切片写入：单字节 chunk、从多字节字符中间切开、
  从 `\r\n` 中间（`\r` 与 `\n` 之间）切开、从 `\n\n` 中间切开。
- 断言：客户端收到的字节与上游发出的**逐字节相同**（不是"内容等价"，是 Buffer 相等）。
  这条守住 `proxy.js` 里 `splitSseEvents()` 的 latin1 字节分帧语义——一旦改成 `toString('utf8')`
  累积，被切断的多字节字符会变成 U+FFFD 且**字节永久丢失**，此用例必红。
- 断言：`content-type: text/event-stream` 透传。

**golden 素材的来源与脱敏**：`cases.ts` 里的 `SSE_FULL` 是按**真实录制报文**的事件词表合成的
（本机 `/tmp/cc-monitor-debug` 的 SSE dump；实测 `thinking_delta` 503 次 / `input_json_delta` 338 次 /
`text_delta` 160 次，并含 `content_block_start`/`ping`/`message_delta`）。dump 里含用户真实对话内容，
**不入库**；入库的是同词表 + 官方协议的**假数据**素材，覆盖 7 种 `KNOWN_SSE_TYPES`
（`error` 由 C8 的 HTTP 错误路径覆盖）与全部 4 种 delta 类型。
`fixtures.test.ts` 会自检这份素材：data 行必须是合法 JSON、必须含真正的多字节字符、
对抗性切片必须**确实**切在多字节序列内部与 CRLF 中间——否则 C7 会「绿着但没用」。

### C8 上游 4xx/5xx 错误路径
- 上游返回 `400` + JSON 错误体 → 客户端看到 `400` + **同一份 body**（SUT 不得吞掉或改写错误体）。
- 上游返回 `529`（Anthropic overloaded）同样原样透传。

### C9 上游连接不可达
- `CC_MONITOR_TARGET` 指向一个**已关闭**的端口。
- 断言：客户端在 2s 内收到 `502`，body 为 JSON 且含 `error` 字段（值为 `proxy_error`）。
  这是现状行为：连接失败 = 502 Bad Gateway。

### C10 上游流中途断开
- 上游发完 SSE 响应头 + 1 个 event 后**强制 destroy** socket。
- 断言：客户端请求在 3s 内**收敛**（正常 end 或错误均可），不得挂死；
  且已收到的字节是上游所发前缀的严格前缀（不得凭空造出后半个 event）。

### C11 并发隔离
- 同时发起 8 个请求（4 个不同 `x-agent-id`，各 2 个并发），上游按各自 body 返回不同内容。
- 断言：每个请求收到的响应体与它自己发出的 body 一一对应（不得串流）。
  这条守住 `proxy.js` 里「cid 必须是请求级 const」的修复（历史上模块级 `let cid` 曾并发互覆）。

---

## 4. base URL 解析优先级（用例 C12）

`GET /config/baseurl` 的 `directUrl` 必须镜像 cc 自己的取值顺序。优先级（高 → 低）：

| # | 来源 | 说明 |
|---|---|---|
| 1 | `CC_MONITOR_TARGET` 环境变量 | 本工具显式逃生口 |
| 2 | `$HOME/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` | **实测优先于环境变量** |
| 3 | `$HOME/.claude/cc-monitor-state.json` 的 `previousBaseUrl` | 上次开监控前的原 URL |
| 4 | `ANTHROPIC_BASE_URL` 环境变量 | |

- 每个来源都**必须跳过指向本代理自己**的值（`localhost`/`127.0.0.1`/`::1` 且端口 == `CC_MONITOR_PORT`），
  否则转发给自己 = 死循环。跳过 ≠ 停止：继续往下一个来源找。
- URL 非法（如 `"not a url"`）同样跳过并继续。
- 全部来源都不可用 → `directUrl` 回落到占位常量 `https://api.anthropic.com`，
  且 **`available=false` + `availableReason` 为非空字符串**（区分「压根没配」与「配了但不可用」两种文案）。

用例矩阵（每例独立起一个 SUT 进程，因为该解析在进程启动时一次性完成）：

| 例 | env | settings.json | state.json | 期望 `directUrl` |
|---|---|---|---|---|
| C12a | `ANTHROPIC_BASE_URL=A` | — | — | `A` |
| C12b | `CC_MONITOR_TARGET=B` | — | — | `B` |
| C12c | `CC_MONITOR_TARGET=B`、`ANTHROPIC_BASE_URL=A` | — | — | `B` |
| C12d | `ANTHROPIC_BASE_URL=A` | `ANTHROPIC_BASE_URL=C` | — | `C`（settings 压过环境变量）|
| C12e | — | — | `previousBaseUrl=D` | `D` |
| C12f | `ANTHROPIC_BASE_URL=A` | `ANTHROPIC_BASE_URL=http://localhost:<SUT_PORT>` | — | `A`（自指被跳过后继续）|
| C12g | — | — | — | `https://api.anthropic.com` 且 `available=false`、`availableReason` 非空 |

---

## 5. settings.json 安全改写（用例 C13–C14）

现状实现：`vendor/cc-monitor/shared/safe-settings-writer.js`，**强制 4 道闸**。

### 5.1 四道闸（**单元级**契约，各实现自带测试）

| 闸 | 语义 |
|---|---|
| 1 差异保护 | `|len(new)-len(old)| / len(old) > maxDeltaRatio`（默认 `0.5`）→ 抛错，文件**一字节不改** |
| 2 写前备份 | 首次写入前把原文件复制为 `<file>.bak`；**`.bak` 已存在则绝不再覆盖**（永远是"用户上次能跑的版本"）|
| 3 原子写 | 写 `<file>.tmp` 再 `rename` 到目标；失败时清理 `.tmp` 并抛错（不得留半截文件）|
| 4 写后校验 | 写完 `JSON.parse` 复核；解析失败 → 从 `.bak` 原子回滚，抛「已回滚」错；回滚也失败 → 抛聚合错 |

补充语义：
- `transform` 返回与原文**完全相同**的字符串 → 直接返回，不做任何 I/O（**不得**创建 `.bak`）。
- 失败一律**抛错**，不得静默吞。
- 回滚成功后的错误文案需含 `restored from backup`；回滚失败需含 `rollback failed`。

### 5.2 HTTP 级可观测不变量（用例 C13/C14，两个实现都要过）

前提：`CC_MONITOR_TARGET` 已设（`available=true`），settings.json 含 `ANTHROPIC_BASE_URL` 键。

- **C13a** `POST /config/baseurl {"action":"enable"}`
  → `200`、`monitoring:true`；settings.json 的值变成 `http://localhost:<SUT_PORT>`；
  `.bak` 出现且内容 == **改动前**的 settings.json 原文。**其余字节一字不动**
  （测试会用「除该值外还有其它 key、含缩进和换行」的真实格式 settings.json 校验）。
- **C13b** 重复 `enable`
  → 幂等：settings.json 内容不变，`.bak` 内容不变。
- **C13c** `POST /config/baseurl {"action":"disable"}`
  → `200`、`monitoring:false`；settings.json 的值回到 `previousBaseUrl`；`.bak` 仍在且未被覆盖。
- **C14** `.bak` 永不覆盖：先 `enable` 生成 `.bak`，然后**手动把 `.bak` 改成哨兵内容**，
  再 `disable` + `enable` → `.bak` 仍等于哨兵内容（证明只创建一次）。
- **C13d** settings.json **不含** `ANTHROPIC_BASE_URL` 键时 `enable`
  → `400` + `error` 含 `ANTHROPIC_BASE_URL`（不得静默写入或写坏文件）。

---

## 6. token 计数（用例 C15，**仅 Rust 侧需要额外端点**）

现状：Node 用 `gpt-tokenizer` 的 `o200k_base`（`require('gpt-tokenizer/cjs/encoding/o200k_base')`），
对每个 SSE delta 的 text/thinking 做 `encode(text).length`。

Rust 实现必须提供 `POST /tokencount`：body `{"text":"..."}` → `200` + `{"tokens": <number>}`。

**C15**：对同一语料（ASCII / 中文 / emoji / 混合 / 空串 / 代码 / 长文本），
Rust `/tokencount` 的 `tokens` 必须与 Node `o200k_base.encode(text).length` **逐例相等**。
不等即说明迁移会改变 TPS / token 统计（用户可见数值回归）。

---

## 7. SSE 分帧器的差分 golden（**独立于 C7，必须单独钉**）

⚠️ **C7 测不到分帧器。** C7 验证的是「响应字节原样过」，而两个实现都是靠**直接转发上游 chunk**
做到这一点（Node：`res.write(chunk)`，见 `proxy.js` 数据回调；Rust：`Body::from_stream(bytes_stream)`）。
`splitSseEvents()` 只服务 dashboard/capture 旁路，**不在透传热路径上** —— 所以**一个分帧器写坏的实现
照样能让 C7 全绿**。分帧器一旦为 dashboard 上热路径，就是最高风险组件，必须单独钉。

- **生成器**：`test/proxy-contract/tools/gen-sse-golden.mjs`。它从 `proxy.js` **正则抠出 `splitSseEvents`
  原文**来跑（不是手抄期望值），固定 seed，**输出确定性**（重跑 md5 不变）。
- **golden**：`test/proxy-contract/fixtures/sse-framing-golden.json` —— **160** 个对抗性用例（88 KB，
  249 个 event，其中 **56** 个含非法 UTF-8）。语料覆盖：孤立 `\r` / `\n`、全部分隔符变体
  （`\n\n` `\r\n\r\n` `\n\r\n` `\r\n\n` `\r\r\n` `\r\n\r`）、不完整尾巴、多字节字符被切碎、随机字节汤。
- **消费方**：`src-tauri/src/proxy/sse.rs::tests::matches_node_golden_fuzz`
  （`include_str!` 编译期嵌入，逐例比对**原始分片**与**有损解码结果**两项）。
- **结果**：Rust 侧 **160/160 全等** —— 分帧与有损 UTF-8 解码都一致（说明 Node 与 Rust 的 lossy 解码器
  在本语料上无差异，dashboard 显示不会出现「Node 显示 1 个 U+FFFD、Rust 显示 2 个」这类漂移）。
- **负向对照已做**：把任一期望值改错，对应用例立刻变红 —— 证明这条测试不是空转。

改 `splitSseEvents()` 或移植分帧器时，**重新生成 golden 并重跑两侧测试**。

---

## 8. 运行方式

```bash
# 一步到位：构建 Rust 侧独立 proxy 二进制 + 跑全部契约用例（Node 与 Rust 两半都跑）
just test-contract

# 等价于：
cargo build --release --features standalone --bin proxy-standalone --manifest-path src-tauri/Cargo.toml
npx vitest run test/proxy-contract

# 分帧器差分 golden：重新生成 + Rust 侧比对（改过分帧逻辑才需要跑生成器）
node test/proxy-contract/tools/gen-sse-golden.mjs
cargo test sse --manifest-path src-tauri/Cargo.toml
```

------

## 9. SSE 推送流契约（用例 C16–C23）

三条推送流（`/requests/stream`、`/events/stream`、`/event/detail/stream`）共用同一套
「**先回放积压 → 再推实时帧 → 空闲时 15s 心跳**」状态机，帧格式也共用：

| 帧 | 逐字形态 | 说明 |
|---|---|---|
| 数据帧 | `data: <单条 JSON 对象>\n\n` | **单条对象，不是数组**；请求流是 `_captureSummary`，事件流是事件对象，详情流是 delta / `{done:true}` |
| 清空控制帧 | `event: clear\ndata: {}\n\n` | 带 `event: clear` 事件名，**不是**普通数据帧 |
| 心跳 | `: ping\n\n` | SSE 注释行，每 15s，防止空闲连接被中间层断掉 |

三条流的响应头必须逐字一致（Node 与 Rust 实测相同）：

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

**回放顺序（C17 / C20）：必须旧→新（升序）。** dashboard 把收到的行 push 到列表末尾，
所以回放「旧在新之前」、随后实时新请求继续往后 append，列表才是「旧在上、新在下」。
降序回放会让历史倒序、与实时追加方向矛盾 —— 这是 Node 侧修过的真实 bug，C17/C20 专门钉它。

端点与数据源：

| 端点 | 数据源 | 积压回放 | 实时来源 |
|---|---|---|---|
| `GET /requests/stream` | 请求捕获环 | 按 `ts` 升序取**末尾 50 条** summary | 请求注册 / 响应头 / 500ms 节流增长 / 流结束 |
| `GET /events/stream` | 异常事件环 | **插入序末尾 50 条**事件 | `recordEvent`（含状态机转换事件） |
| `GET /event/detail/stream?cid=` | 单个捕获条目的 SSE 字节 | 已切出的 `content_block_delta`（`ts:0`） | 流中 delta / 结束时 `{done:true}` + **关流** |
| `POST /requests/clear` | — | — | 订阅者读到 `event: clear`；响应体 `{ok:true,cleared:<真实条数>}` |
| `POST /events/clear` | — | — | 订阅者读到 `event: clear`；响应体是**字面量** `{ok:true,cleared:0}` |

⚠️ 两个 clear 的 `cleared` **刻意不同**：`/requests/clear` 回报真实条数（C19 断言 `=2`），
`/events/clear` 无论清掉多少条都是字面量 `0`（C21 断言清空前环里确有事件、响应体仍是 0）。
这是现状 Node 的行为，**不要「修正」成一致**。

用例矩阵（同一批用例跑在 Node 与 Rust 两个实现上）：

| 用例 | 端点 | 钉住什么 |
|---|---|---|
| C16 | `/requests/stream` | 四条响应头；回放帧是**单条 summary 对象**（不是数组）；`_captureSummary` 的 14 键键集；`cid` 满足 `/^[a-f0-9-]{8,64}$/i`（否则 `/event/detail` 取不回） |
| C17 | `/requests/stream` | 积压回放**旧→新**；连上后再捕获的实时帧排在回放**之后**；`ts` 非降 |
| C18 | `/requests/stream` | 实时帧：同一请求先 `ended:false` 再 `ended:true`；每帧单条对象；同一 `cid`；结束帧 `statusCode` / `respBodySize` 正确 |
| C19 | `/requests/clear` | 订阅者收到逐字 `event: clear` + `data: {}`；响应体 `cleared` 是**真实条数** |
| C20 | `/events/stream` | 四条响应头；事件积压**旧→新**；事件 7 键键集；`severity` / `agentId` 正确 |
| C21 | `/events/clear` | 订阅者收到逐字 `event: clear` + `data: {}`；响应体是**字面量** `{ok:true,cleared:0}`（前提自检：环里确有事件） |
| C23 | `/event/detail/stream` | 已结束的 SSE 捕获：先回放 delta（`ts:0`）再 `{done:true}` 并**关流**；缺参 → `400`、未知 cid → `404`（同文案） |
| C22 | `/requests/stream` | **心跳**：空闲连接按 15s 发 `: ping`。**默认不注册**，见下 |

### 9.1 心跳用例默认不注册（C22）

心跳间隔是**硬编码 15s**（Node `setInterval` / Rust `interval_at`），没有环境变量可缩短；
黑盒观察它就必须真等 15s。为不把整个套件从 ~2s 拖到 ~34s，C22 **默认不注册**（默认运行里
既不执行也不计入 skip），需要时显式开启：

```bash
CC_CONTRACT_HEARTBEAT=1 npx vitest run test/proxy-contract/stream.test.ts
```

它断言 `/requests/stream` 上 20s 内到达的第一帧是**逐字** `: ping`（SSE 注释行，不带 `data`）。
两实现实测均在 15.0s 到达（Node 15017ms / Rust 15008ms）。

### 9.2 已记录的刻意偏差（不要改成「一致」）

- **JSON 键序**：Node 是字面量序，Rust 的 `serde_json` 默认为字典序。本组用例只比键**集合**与取值，不比原始字符串。
- **空积压时的响应头时机**：Node 的 `res.writeHead` 在首个 `res.write` 前不 flush，空积压时首个字节就是 15s 心跳；
  Rust/axum 立即 flush 响应头。对 EventSource 两者等价，故不作断言。
- **请求开始时 `statusCode=0` 的 pending 帧**：Node 在请求刚到达就注册捕获并广播一次 pending；
  Rust 在 `send()` 拿到响应头后才注册，**没有**这一帧（连带 `upstream-tcp-error` 没有可查的捕获详情）。
  这是已定案的结构性差异（理由见方案文档 §8bis「下一步 4」），故本组用例不断言它 ——
  差分只钉两个实现**共同**满足的性质，不把 Node 独有行为写成契约。
