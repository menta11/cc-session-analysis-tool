// cc-monitor MITM proxy: intercepts API calls, extracts per-agent token streaming
// Config: config.json next to this script
// Usage: node proxy.js
// Set ANTHROPIC_BASE_URL=http://localhost:<port> before starting cc

const http = require('http');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadConfig } = require('./shared/config');
// 实时 output TPS 估算用 tokenizer. gpt-tokenizer 默认 o200k_base (GPT-4o 系 BPE),
// 是公开词表里最接近 Claude 4 的. Claude 3/4 真实 tokenizer 未公开 → 这是估计值;
// 流末仍用真实 output_tokens 收口 (lastRealTps). 纯 JS → Win/Mac 通用, Electron 友好.
const { encode } = require('gpt-tokenizer');
const countTokens = (text) => encode(text || '').length;

// 本文件作为外部模块由主进程运行时 require (不进 bundle), 由 viteStaticCopy 拷到
// out/main/monitor/proxy.js — __dirname 即资产目录 (dashboard.html / mini.html / config.json 同级).
const MONITOR_DIR = __dirname;
// Dev 模式(electron . 未打包): 开启 dashboard 热加载 — 每次请求读磁盘 + 暴露 mtime 端点供前轮询自动刷新
const DEV = !!process.defaultApp;
const config = loadConfig(MONITOR_DIR);
const PORT = config.port;

// --- Debug dump (临时诊断: 捕获"WAITING 长 + STREAM 几乎无"异常路径) ---
// 触发条件: SSE 已开 + lastDeltaTs===0 持续 > DUMP_NO_DELTA_MS, 或
//           状态 WAITING 持续 > DUMP_WAITING_MS. 命中后把 stream 状态 +
//           原始 buf hexdump 落盘到 /tmp/cc-monitor-debug/, 不打断主流程.
// 关: CC_MONITOR_DEBUG=0. 默认开 (改完先开着, 等问题复现拿数据).
const DEBUG_DUMP = process.env.CC_MONITOR_DEBUG !== '0';
const DEBUG_DUMP_DIR = '/tmp/cc-monitor-debug';
const DUMP_NO_DELTA_MS = 5000;   // SSE open 5s 还没 delta → 嫌疑 A (chunk 边界卡位)
const DUMP_WAITING_MS = 10_000;  // WAITING 持续 10s → 嫌疑 A/B 兜底
const DUMP_MIN_INTERVAL_MS = 60_000;  // 同 agent 60s 内最多 dump 1 次, 防反复写盘
const _dumpLastTs = new Map();  // agentId → 上次 dump 时刻
function debugDumpIfStuck(agentId, s, buf, trigger, reqCid) {
  if (!DEBUG_DUMP) return;
  const now = Date.now();
  const last = _dumpLastTs.get(agentId) || 0;
  if (now - last < DUMP_MIN_INTERVAL_MS) return;
  // 触发条件判定
  let stuckSince = 0;
  if (trigger === 'no_delta' && s.startTs > 0) stuckSince = now - s.startTs;
  if (trigger === 'waiting' && s.startTs > 0) stuckSince = now - s.startTs;
  if (trigger === 'no_delta' && stuckSince < DUMP_NO_DELTA_MS) return;
  if (trigger === 'waiting' && stuckSince < DUMP_WAITING_MS) return;
  // 写盘
  try {
    if (!fs.existsSync(DEBUG_DUMP_DIR)) fs.mkdirSync(DEBUG_DUMP_DIR, { recursive: true });
    const fname = `${DEBUG_DUMP_DIR}/dump-${now}-${agentId.replace(/[^a-z0-9:_-]/gi, '_')}.log`;
    // buf 统一成 Buffer (旁路 buf 现已是 Buffer; 兼容历史 String 调用). 字节级 hexdump, 不做 utf8 解码.
    const _buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '', 'utf8');
    const hex = _buf.toString('hex');
    // 16 字节一行, 便于肉眼扫 CRLF 边界 (0d 0a 0d 0a)
    const hexLines = [];
    for (let i = 0; i < hex.length; i += 32) hexLines.push(hex.slice(i, i + 32));
    const asciiLines = [];
    for (let i = 0; i < _buf.length; i += 16) {
      let row = '';
      for (let j = i; j < Math.min(i + 16, _buf.length); j++) {
        const b = _buf[j];
        row += (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.';
      }
      asciiLines.push(row);
    }
    // 标出 CRLF (\r\n) 的位置 - 帮助判断 split('\n\n') 能否切对.
    // latin1 = 每字节1字符无损映射, 仅用于定位边界 (不做 utf8 解码).
    const _bs = _buf.toString('latin1');
    const crlfCount = _bs.split('\r\n\r\n').length - 1;
    const lfOnlyCount = _bs.split('\n\n').length - 1;
    const payload = [
      `# cc-monitor debug dump`,
      `# trigger:        ${trigger}  (阈值: no_delta>${DUMP_NO_DELTA_MS}ms, waiting>${DUMP_WAITING_MS}ms)`,
      `# agentId:        ${agentId}`,
      `# stuckFor:       ${stuckSince}ms  (= now - s.startTs)`,
      `# dumpAt:         ${new Date(now).toISOString()}`,
      `# bufByteLen:     ${_buf.length}`,
      `# bufCharLen:     ${_buf.toString('utf8').length}`,
      `# CRLF event count (\r\n\r\n occurrences):  ${crlfCount}`,
      `# LF-only event count (\n\n occurrences):   ${lfOnlyCount}`,
      `# split('\\n\\n') can split this buf?  ${lfOnlyCount > 0 ? 'YES' : 'NO  ← chunk 边界卡位嫌疑'}`,
      ``,
      `# === stream state (s) ===`,
      JSON.stringify(s, null, 2),
      ``,
      `# === raw buf hexdump (16 bytes/line) ===`,
      ...hexLines,
      ``,
      `# === raw buf ascii (printable only, . = control char) ===`,
      ...asciiLines,
      ``,
    ].join('\n');
    fs.writeFileSync(fname, payload);
    _dumpLastTs.set(agentId, now);
    console.warn(`[dump] ${trigger} agent=${agentId} buf=${_buf.length}bytes → ${fname}` + (reqCid ? ` trace=${reqCid.slice(0,8)}` : ''));
  } catch (e) {
    console.error('[dump] write failed:', e.message);
  }
}

// SSE event 分帧: 在原始字节 Buffer 上按 \r?\n\r?\n 切完整 event.
// 旁路累积 buf 必须是字节 Buffer — 若用 toString 后的 string, 跨 chunk 的多字节字符
// (中文/emoji) 会被 utf8 有损解码成 U+FFFD, 字节永久丢失, dashboard 实时打印 / SSE 详情
// 出现 "��" 乱码. 字节层切分 + 每个 event 独立 utf8 解码 → 无损.
function splitSseEvents(buf) {
  // latin1 = 每字节1字符无损映射, 仅用于定位 \n\n 边界, 不做 utf8 解码.
  const s = buf.toString('latin1');
  const parts = s.split(/\r?\n\r?\n/);
  const tail = parts.pop() || '';
  return {
    events: parts.map(p => Buffer.from(p, 'latin1').toString('utf8')),
    rest: Buffer.from(tail, 'latin1'),
  };
}

// 字节级 utf-8 validator: 扫出所有非法字节偏移 (孤立续字节 / 不完整序列 / 过长序列).
// 用途: 检测上游/中转站字节损坏 (dashboard 显示 U+FFFD 的根因定位). 纯诊断, 不改字节.
function _scanUtf8Errors(buf) {
  const errors = [];
  const isCont = (b) => (b & 0xC0) === 0x80;  // 10xxxxxx 续字节
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    let seqlen;
    if (b <= 0x7F) seqlen = 1;                    // 0xxxxxxx ASCII
    else if ((b & 0xE0) === 0xC0) seqlen = 2;     // 110xxxxx
    else if ((b & 0xF0) === 0xE0) seqlen = 3;     // 1110xxxx (中文)
    else if ((b & 0xF8) === 0xF0) seqlen = 4;     // 11110xxx (emoji)
    else { errors.push(i); i++; continue; }       // 非法起始字节 (孤立续 / 过长)
    let valid = true;
    for (let j = 1; j < seqlen; j++) {
      if (i + j >= buf.length || !isCont(buf[i + j])) { valid = false; break; }
    }
    if (!valid) {
      errors.push(i);                              // 序列不完整 (截断/被截)
      // 跳过紧跟的续字节 (属于本失败序列, 不重复计 — 贴近真实 decoder 的 1 U+FFFD)
      let j = i + 1;
      while (j < buf.length && isCont(buf[j])) j++;
      i = j;
    } else i += seqlen;
  }
  return errors;
}

// SSE 流结束旁路: 扫 sseBytes 非法字节 → 上报「上游字节损坏」事件 + dump hex 取证.
// 触发: sseBytes 含非法 utf-8 (toString 出现 U+FFFD). dashboard 事件流 + 诊断详情 tab 可见.
// 铁律: 字节到 proxy 时已损坏, 不可恢复; 此函数仅取证 (偏移 / 字节值 / 上下文), 不动主路径.
function _scanAndReportCorruption(sseBytes, agentId, reqCid) {
  const offsets = _scanUtf8Errors(sseBytes);
  if (offsets.length === 0) return;
  // 合并相邻错误 (一个中文 3 字节坏 → 1 簇), 避免重复 dump
  const clusters = [];
  for (const off of offsets) {
    const last = clusters[clusters.length - 1];
    if (last && off - last.end <= 2) last.end = off + 1;
    else clusters.push({ start: off, end: off + 1 });
  }
  const samples = clusters.slice(0, 6).map(c => {
    const a = Math.max(0, c.start - 12), b = Math.min(sseBytes.length, c.end + 12);
    return {
      byteOffset: c.start,
      badBytes: sseBytes.slice(c.start, c.end).toString('hex'),
      contextHex: sseBytes.slice(a, b).toString('hex'),
      contextText: sseBytes.slice(a, b).toString('utf8').replace(/�/g, '·'),
    };
  });
  recordEvent({
    severity: 'warn', type: 'upstream-byte-corruption', agentId,
    message: `检测到上游字节损坏 (${clusters.length} 处, 共 ${offsets.length} 个非法字节)`,
    detail: { clusters: clusters.length, totalBadBytes: offsets.length, samples, sseBytesLen: sseBytes.length },
  }, reqCid);
}

// trace 日志: 自动带 trace=<cid 前 8 位> 前缀, 排查问题时 grep 一个 trace 就能拉出一条请求的所有日志.
// traceId 由调用方显式传 (请求级 cid), 并发请求各自独立, 不串.
function _log(tag, msg, traceId) {
  const t = new Date().toISOString().slice(11, 19);
  const c = traceId ? ` trace=${traceId.slice(0, 8)}` : '';
  console.log(`[${t}] [${tag}]${c} ${msg}`);
}

// --- ~/.claude paths + regex ---
// 必须提前声明: resolveApiUrl() 在 line 68 模块顶层调用 getSettingsBaseUrl()/
// loadMonitorState(), 引用这些 const. 之前在 508+ 才声明 → TDZ ReferenceError →
// try/catch 兜底返 null → 静默兜底到 https://api.anthropic.com → cc 403.
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
// State lives outside the app bundle (~/.claude/) so user preferences survive
// reinstalls. The bundle path (APP_DIR) is wiped on reinstall.
const STATE_PATH = path.join(os.homedir(), '.claude', 'cc-monitor-state.json');
const PROXY_BASEURL = `http://localhost:${PORT}`;
const BASEURL_RE = /("ANTHROPIC_BASE_URL"\s*:\s*")([^"]*)(")/

// 判定已解析 URL 是否指向 proxy 自己 (loopback + 同 PORT). 转发到自己 = 死循环, 必跳.
// 精确到 port: localhost:11434 (本地 LLM 上游) ≠ proxy 自己, 不跳 — 只挡 localhost:PORT.
function isProxySelf(u) {
  const loop = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  return loop && u.port === String(PORT);
};

// 仅输入侧估算用 (estimateInputTokens: message_start.usage.input_tokens 不可用时的 fallback).
// 输出侧已改用 gpt-tokenizer (countTokens) 数真实 token, 不再需要 chars/token 启发式.
const CHARS_PER_INPUT_TOKEN = 2.5;

// Agent state machine thresholds (milliseconds).
const STREAM_STUCK_MS = 60000;       // no delta for this long → mark SSE_STUCK (10s 误报率高: 思考段切换/text 长停顿会瞬超; 60s 才算真卡位)
// 流尾 stop_reason=tool_use 后, main agent 进入 WORK 态 (CC 跑工具期间 proxy
// 看不到流量). 30s 太短 — npm install / 长 grep / 编译 / 大文件读经常 > 30s,
// 此时 calcAgentStatus 会从 WORK 切回 IDLE, 但 cc 实际还在跑 tool, 显示与现实
// 脱节. 拉到 5min 覆盖常见工具调用; sub 仍 30s (sub fork 完应秒回, 30s 不回算孤儿).
// 注意: 与 isAgentActive 用的 WORK_FOLLOWUP_MS_MAIN (10min, 清理用) 是两套阈值,
// 一个管"显示", 一个管"清不清". 显示阈值应 < 清理阈值, 防显示早切 IDLE 又被清.
const WORK_FOLLOWUP_MS_SUB = 30_000;  // sub-agent tool_use → 30s 不回下一流算孤儿 (calcAgentStatus 显示用)
const WORK_DISPLAY_MS_MAIN = 300_000;  // main agent tool_use → 5min 兜底 (calcAgentStatus 显示用)
// end_turn 后保持 STREAM 视觉的收尾缓冲. cc 终端渲染 (中文/长文/markdown 逐字)
// 滞后于 SSE 接收: proxy 已收完回复 (end_turn → 本该 IDLE) 但 cc 终端还在打字 → 用户看到
// "字还在打, mini/面板却 idle". 此窗口内不切 IDLE, 覆盖常见渲染延迟. 见 calcAgentStatus end_turn 分支.
const STREAM_TAIL_MS = 3000;
const IDLE_CLEANUP_MS_SUB = 60_000;  // sub-agents 非正常结束(tool_use 中断/WORK)的清理缓冲; 正常 end_turn 用完即清
let IDLE_CLEANUP_MS_MAIN = 120_000; // main agents idle 超过此值 → drop; 运行中可通过 /config/idle 调整
const _IDLE_CLEANUP_MS_MAX = 3_600_000;  // 上限 1h, 防配错把 agent 永远留表里

// 启动时把 state.json 里的用户偏好套到 module-level 变量上.
// 函数体引用 STATE_PATH (line 483), 必须在 STATE_PATH 声明后调用 — 见下方.
function applyStateOverrides() {
  const s = loadMonitorState();
  if (Number.isFinite(s.idleCleanupMsMain) && s.idleCleanupMsMain >= 0) {
    IDLE_CLEANUP_MS_MAIN = Math.min(s.idleCleanupMsMain, _IDLE_CLEANUP_MS_MAX);
  }
}

// Resolve real API endpoint (NOT from ANTHROPIC_BASE_URL — that points to us).
// Priority:
//   1. monitor-state.json previousBaseUrl (上次开监控前的原 URL, 监控重启时记得真实中转站)
//   2. ~/.claude/settings.json env.ANTHROPIC_BASE_URL (跳过 localhost — 此时指向本代理自己)
//   3. Anthropic 官方
function resolveApiUrl() {
  const state = loadMonitorState();
  if (state.previousBaseUrl) {
    try {
      const u = new URL(state.previousBaseUrl);
      if (!isProxySelf(u)) return state.previousBaseUrl;
    } catch (e) {}
  }
  const fromSettings = getSettingsBaseUrl();
  if (fromSettings) {
    try {
      const u = new URL(fromSettings);
      if (!isProxySelf(u)) return fromSettings;
    } catch (e) { /* invalid url, fall through */ }
  }
  return 'https://api.anthropic.com';
}

const BASE_URL = resolveApiUrl();
const parsed = new URL(BASE_URL);
const API_HOST = parsed.hostname;

// Proxy loop detection (测试模式: CC_MONITOR_LOOP_BYPASS=1 允许 localhost)
if (process.env.CC_MONITOR_LOOP_BYPASS !== '1' &&
    (API_HOST === 'localhost' || API_HOST === '127.0.0.1' || API_HOST === '::1')) {
  console.error(`[proxy] FATAL: API URL points to localhost (${BASE_URL})`);
  console.error(`[proxy] Set CC_MONITOR_TARGET env or fix ~/.claude/settings.json base url`);
  process.exit(1);
}

// No upstream resolved: when monitoring was never opened (or state was wiped),
// we have no record of the user's real API endpoint, so we MUST NOT silently
// fall back to the official api.anthropic.com — that breaks anyone using a
// Fail loud instead. User fixes via: enable monitoring once in dashboard
// (records previousBaseUrl).
if (BASE_URL === 'https://api.anthropic.com'
    && !loadMonitorState().previousBaseUrl) {
  const fromSettings = getSettingsBaseUrl();
  if (!fromSettings || /localhost|127\.0\.0\.1/.test(fromSettings)) {
    console.error(`[proxy] FATAL: no upstream API URL resolved.`);
    console.error(`[proxy] state.previousBaseUrl: ${loadMonitorState().previousBaseUrl || '(unset)'}`);
    console.error(`[proxy] settings.json baseurl: ${fromSettings || '(unset)'}`);
    console.error(`[proxy] Fix: open monitoring once in the dashboard (records your real URL).`);
    process.exit(1);
  }
}

const API_PORT = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
const API_PATH_PREFIX = parsed.pathname.replace(/\/$/, '');
const IS_HTTPS = parsed.protocol === 'https:';
const requestModule = IS_HTTPS ? require('https') : require('http');

// Per-agent token tracking
// key: agentId, value: { chars, deltas[], requestCount, lastTs }
const agents = new Map();

// Active SSE stream registry: agentId → Set<{res, proxyReq, closed}>.
// Lets us destroy a stuck agent's streams on demand so cc sees a connection
// reset and its SDK auto-retries the request.
const activeStreams = new Map();

// Agent fingerprint → friendly name mapping
const agentFingerprints = new Map();
// Agent name → metadata (for dashboard grouping)
const agentMeta = new Map(); // name → { sessionId, isSubagent }

// --- 异常事件流 (SSE / 业务 / 时序异常 → dashboard 顶部事件流带) ---
// 内存 ring buffer 200 条, 进程退出即丢. 同 agent+type 60s 内合并 (count 累加).
// 订阅者: text/event-stream 客户端, 通过 /events/stream 推.
const events = [];
const MAX_EVENTS = 200;
const EVENT_DEDUPE_MS = 60_000;
const SSE_WATCHDOG_MS = 60_000;  // 上游流无活动超过此时长 → upstream-timeout 事件
const SSE_EVENT_BACKLOG = 50;    // 新订阅者回放最近 N 条, 避免空白

// --- HTTP 详情 capture ring ---
// 每个外发请求 (一个 cc→proxy 请求 = 一个 cid) 存 req/resp/SSE 字节流快照,
// dashboard 点 ev-row 时通过 /event/detail?cid= 取回渲染, 类似 Chrome DevTools Network.
// LRU 200 条: 溢出时按 lastAccessTs 升序砍最久未访问. 进程退出即丢.
// 不再按字节数截断: copy-as-curl 需要完整 body / SSE, 截断后无法重建原请求.
// 大请求风险由 LRU 200 条保护: 用户反复访问的旧数据会被自然淘汰.
const captureRing = new Map();   // cid → entry
const CAPTURE_MAX = 200;

// 流请求过滤名单: 命中 pathname 即 404 + 直接返回 —— 不进 capture ring (流请求 tab 看不到)、
// 也不转发 LLM。放 dashboard 自身 housekeeping 端点 (热加载轮询 / 内部探测), 避免 noise 污染流请求列表。
// 新增内部端点 → 这里加一行即可, 仅按 pathname 精确匹配 (忽略 query string)。
// 注意: DEV 下 /__dev_* 已由上方 handler 命中并返回 200; 此名单主要拦 PROD 泄漏 + 未来新增端点。
const STREAM_REQUEST_BLOCKLIST = new Set([
  '/__dev_mtime__',       // dashboard 热加载轮询
  '/__dev_mini_mtime__',  // mini 悬浮窗热加载轮询
]);

// cid 是请求级 const (见下方主代理 handler: const cid = randomUUID()).
// recordEvent(ev, cid) / _log(tag, msg, cid) 显式传 — 并发请求各自独立, 不串.
// 历史曾用模块级 let cid, 并发请求互相覆盖 → 被覆盖请求 statusCode/endAt 写错
// entry → 永久 pending (dashboard 橙色不结束). 请求级 const 根治.

// cc-monitor 不做 header 脱敏 — copy as curl 需要完整原始值, 方便复现请求.
function _evictCapture() {
  if (captureRing.size <= CAPTURE_MAX) return;
  // 仅溢出时 sort, 不在热路径. 200×log(200)≈1500 次比较 < 0.01ms.
  const arr = Array.from(captureRing.values())
    .sort((a, b) => a.lastAccessTs - b.lastAccessTs);
  const drop = arr.slice(0, captureRing.size - CAPTURE_MAX);
  for (const e of drop) captureRing.delete(e.cid);
}

// 查找 ring 中同 agentId+type 的最近一条 (从后往前). 命中 = dedupe 合并目标.
function _lastIdxOfEvent(agentId, type) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === type && (e.agentId || null) === (agentId || null)) return i;
  }
  return -1;
}

// Event 字段: { ts, count, lastTs, severity, type, agentId, message, detail }
// 调用方只填 severity/type/agentId/message/detail, ts/count 由 recordEvent 注入.
function recordEvent(ev, reqCid) {
  if (!ev || !ev.type || !ev.severity) return;
  // ★ reqCid 显式传 (请求级 const, 见主代理 handler): 同请求内多次 recordEvent
  //   (stop_reason / parse-fail / sse-stuck 等) 共享同一 correlationId, 前端点
  //   ev-row 时用它拉 /event/detail. 历史是模块级 let cid, 并发请求互相覆盖 →
  //   被覆盖请求 statusCode/endAt 写错 entry → 永久 pending. 传参根治.
  const c = reqCid || null;
  if (c) {
    ev.detail = ev.detail || {};
    if (!ev.detail.correlationId) ev.detail.correlationId = c;
  }
  const now = Date.now();
  const agentId = ev.agentId || null;
  const lastIdx = _lastIdxOfEvent(agentId, ev.type);
  if (lastIdx >= 0 && now - events[lastIdx].ts < EVENT_DEDUPE_MS) {
    events[lastIdx].count = (events[lastIdx].count || 1) + 1;
    events[lastIdx].lastTs = now;
    _broadcastEvent(events[lastIdx]);
    return;
  }
  ev.ts = now;
  ev.count = 1;
  if (agentId) ev.agentId = agentId; else ev.agentId = null;
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
  _broadcastEvent(ev);
  // 同步写 captureRing: 让 /event/detail 拿到该 cid 全部 recordEvent 快照.
  // 防御性: captureRing 可能已 LRU 淘汰. reqCid 由调用方显式传 (无 req 上下文的
  // 调用如 _emitStateTransition 传 undefined → 仅进事件流, 不写 capture).
  // 去重分支已提前 return, 不重复 push.
  if (c) {
    const ent = captureRing.get(c);
    if (ent) {
      // correlationId 是实现细节 (前端用 cid 拉详情, 不需要回显), 浅拷贝剔除.
      const det = ev.detail || {};
      const cleanDetail = {};
      for (const k of Object.keys(det)) {
        if (k === 'correlationId') continue;
        cleanDetail[k] = det[k];
      }
      ent.details.push({
        ts: ev.ts, type: ev.type, severity: ev.severity,
        message: ev.message, detail: cleanDetail,
      });
    }
  }
}

// SSE 订阅者: 每个客户端一个 res. 心跳 15s 一行 ": ping\n\n".
const eventClients = new Set();
const SSE_HEARTBEAT_MS = 15_000;
function _broadcastEvent(ev) {
  const line = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const r of eventClients) {
    try { r.write(line); } catch (e) { eventClients.delete(r); }
  }
}
// 控制消息: 不入 events 业务 ring, 独立推送. 订阅端识别后只清本地视图.
// 复用 /events/stream 同一条 SSE 连接, 浏览器无感知.
function _broadcastClear() {
  const line = 'event: clear\ndata: {}\n\n';
  for (const r of eventClients) {
    try { r.write(line); } catch (e) { eventClients.delete(r); }
  }
}

// 流请求: 独立 SSE 通道 /requests/stream, 推送 capture ring 的 summary.
// 请求开始 (statusCode=0 pending) 即推, SSE 流式中按节流间隔推 size 增长, 结束推最终态.
// summary 不含 body, 详情走 /event/detail?cid= 拉. 单条 summary 约 200B, 50 条 ~10KB.
const requestClients = new Set();
// 流式进度广播��流: 同一 cid 流中最多 1/THROTTLE 次/秒, 避免高频 chunk 抖 DOM; end 时强制最终广播.
const REQUEST_BROADCAST_THROTTLE_MS = 500;
function _captureSummary(e) {
  // 首字耗时: SSE → 第一个内容 delta 到达 (firstCharAt, 真正"首字"); 非 SSE → 响应头到达 (firstByteAt). 未到 → null.
  // 总耗时: 流 end 时 endAt - ts; 流进行中 → Date.now() - ts (估算, 持续增长).
  const now = Date.now();
  const _fb = e.isSSE ? e.firstCharAt : e.firstByteAt;
  const firstByteMs = _fb != null ? (_fb - e.ts) : null;
  const totalMs = (e.endAt != null ? e.endAt : now) - e.ts;
  // phase: 流进行中 (pending) 的当前 delta 类型, 让 dashboard 流请求行按 think(紫)/text(橙) 染色.
  // 与 agent 行 STREAM(think/text) 同源 — 都取该流所属 agent 的 lastDeltaType.
  // 流结束 phase=null → 完成态按 ok/err 染色 (绿/红), 不受 phase 影响 ("完成颜色不变").
  // 无 delta 时 (SSE 刚开等首字 / agentId 未知) phase=null → 退回默认橙.
  let phase = null;
  if (e.endAt == null && e.agentId && e.agentId !== 'unknown') {
    const _dt = agents.get(e.agentId)?.stream?.lastDeltaType;
    phase = _dt === 'thinking' ? 'think' : (_dt === 'text' ? 'text' : null);
  }
  return {
    cid: e.cid, ts: e.ts, agentId: e.agentId, method: e.method, url: e.url,
    statusCode: e.statusCode || 0, isSSE: e.isSSE,
    // SSE 流: 上游响应头一到就是 200, 但字节可能还在持续输出. ended (endAt 落定) 才代表流真结束,
    // dashboard 据此区分"进行中" vs "完成", 不能靠 statusCode (会误判流式中段为已完成).
    ended: e.endAt != null,
    phase,
    reqBodySize: e.reqBodySize, respBodySize: e.respBodySize, sseBytesSize: e.sseBytesSize,
    firstByteMs, totalMs,
  };
}
function _broadcastRequest(summary) {
  const line = 'data: ' + JSON.stringify(summary) + '\n\n';
  for (const r of requestClients) {
    try { r.write(line); } catch (e) { requestClients.delete(r); }
  }
}
function _broadcastRequestClear() {
  const line = 'event: clear\ndata: {}\n\n';
  for (const r of requestClients) {
    try { r.write(line); } catch (e) { requestClients.delete(r); }
  }
}

// 流结束收尾: 设 endAt + _streamEnded, 广播最终 summary 给流请求 tab.
// SSE 流有 4 条结束路径 (正常 end / 上游 error / cc 断开 close / proxyReq error),
// dashboard 用 summary.ended (= endAt!=null) 判定褪色 (橙→灰/绿). 漏任一条广播
// → 该行永远卡橙. 统一在此收尾, 杜绝散落赋值 + 顺序错误 (曾 bug: 正常 end 先
// 广播后设 endAt, 广播出去 ended:false).
function _finalizeRequestCapture(cid) {
  if (!cid) return;
  const e = captureRing.get(cid);
  if (!e) return;
  if (e.endAt == null) e.endAt = Date.now();
  e._streamEnded = true;  // 后续 detail/stream 新订阅者立即收到 done
  _broadcastRequest(_captureSummary(e));
}

// 详情实时 SSE: 按 cid 维度订阅. proxy 在 SSE data 回调切出完整 part 后立即把 delta 推
// 给该 cid 订阅者 (流式逐字追加, 避免 dashboard 轮询延迟). 流结束推 {done:true}.
// payload: {kind:'thinking'|'text', text, ts} 或 {done:true}.
const detailClients = new Map();  // cid → Set<res>
function _broadcastDetail(cid, payload) {
  const set = detailClients.get(cid);
  if (!set || set.size === 0) return;
  const line = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const r of set) {
    try { r.write(line); } catch (e) { set.delete(r); }
  }
}

// 状态机事件: 比对 _lastState[id] vs 当前计算 state, 转换时 emit.
// 注意 calcAgentStatus 是纯读函数, 副作用放这里. 10s 一次 (_tickCleanup 频率),
// 转换粒度足够 (SSE_STUCK/WAITING 都是 10s+ 才升 warn).
const _lastState = new Map();
const _lastStopReason = new Map();
// 状态机转换白名单: prev→curr → { severity, type, message, onlyIfMs? }
// 兜底: *→DISCONNECTED (任意态→DISCONNECTED 走同一事件)
// 未在表内的转换不报 (避免误报, 例 IDLE→STREAM 状态机里不存在).
const TRANSITIONS = {
  'STREAM→SSE_STUCK':      { severity: 'warn', type: 'sse-stuck',         message: 'SSE 卡住 (>10s 无 delta)' },
  'SSE_STUCK→STREAM':      { severity: 'info', type: 'sse-resumed',       message: 'SSE 恢复' },
  'WAITING→STREAM':        { severity: 'info', type: 'first-delta',       message: '收到首字' },
  'STREAM→WORK':           { severity: 'info', type: 'tool-started',      message: '进入工具调用' },
  'STREAM→IDLE':           { severity: 'info', type: 'end-turn',          message: '对话结束' },
  'WORK→IDLE':             { severity: 'info', type: 'work-done',         message: '工具结束 (无新请求)' },
  'WORK→WAITING':          { severity: 'info', type: 'work-followup',     message: '工具结束, 新请求已发' },
  'WAITING→IDLE':          { severity: 'warn', type: 'sse-slow-response', message: '等首字超时/异常', onlyIfMs: 60_000 },
  '*→DISCONNECTED':        { severity: 'warn', type: 'agent-killed',      message: '已显式断开' },
  'DISCONNECTED→WAITING':  { severity: 'info', type: 'cc-retry',          message: 'cc 重试新请求' },
};
function _emitStateTransition(prev, curr, id, st) {
  if (prev === curr) return;
  if (prev === undefined) return;  // 首次建表, 不发"凭空出现"事件
  const key = `${prev}→${curr}`;
  let t = TRANSITIONS[key] || (curr === 'DISCONNECTED' ? TRANSITIONS['*→DISCONNECTED'] : null);
  if (!t) return;
  if (t.onlyIfMs && st.stateMs < t.onlyIfMs) return;
  recordEvent({
    severity: t.severity,
    type: t.type,
    agentId: id,
    message: t.message + (t.onlyIfMs ? ` (>${t.onlyIfMs / 1000}s)` : ''),
    detail: { prev, curr, stateMs: st.stateMs },
  });
}

function extractSystemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

// Estimate input tokens from request body
// Chinese: ~1 char/token, English: ~4 chars/token, mixed ~3 chars/token
function estimateInputTokens(req, body) {
  const p = parseJsonBodyCached(req, body);
  if (!p) return 0;
  let charCount = 0;
  // System prompt
  charCount += extractSystemText(p.system).length;
  // All messages
  if (Array.isArray(p.messages)) {
    for (const m of p.messages) {
      const c = m.content;
      if (typeof c === 'string') {
        charCount += c.length;
      } else if (Array.isArray(c)) {
        for (const block of c) {
          if (typeof block.text === 'string') charCount += block.text.length;
          else if (typeof block.content === 'string') charCount += block.content.length;
        }
      }
    }
  }
  return Math.max(1, Math.round(charCount / CHARS_PER_INPUT_TOKEN));
}

// Body parse cache: the request body may be JSON-parsed more than once per request
// (getAgentId, estimateInputTokens, future handlers). Memoize on req to avoid
// re-parsing large message-history payloads.
function parseJsonBodyCached(req, body) {
  if (req._ccBodyParsed !== undefined) return req._ccBodyParsed;
  if (!body) return (req._ccBodyParsed = null);
  try {
    return (req._ccBodyParsed = JSON.parse(body));
  } catch (e) {
    return (req._ccBodyParsed = null);
  }
}

function getAgentId(req, body) {
  // 只对真正的 LLM 调用识别成 agent. 其他请求 (GET /version, GET /models, GET /api/tags 这种
  // ollama/服务探测) 即使有 UA 也走 fallback, 不进 agents map, 避免噪音挤占列表.
  //   Anthropic API: POST /v1/messages
  //   OpenAI 兼容:   POST /v1/chat/completions
  const url = req.url || '';
  const isLLMCall = req.method === 'POST' &&
    (url.includes('/v1/messages') || url.includes('/chat/completions') || url.includes('/completions'));
  if (!isLLMCall) {
    // 不识别成 agent, capture ring 仍会记录 (流请求 tab 可看), 但 agentId='unknown'
    // 不进 ensureAgent, 不占 dashboard agent 列表
    return 'unknown';
  }

  // Priority 1: explicit x-agent-id header
  if (req.headers['x-agent-id']) return req.headers['x-agent-id'];

  // Priority 2: Claude Code session + agent-id headers
  const sessionId = req.headers['x-claude-code-session-id'];
  const codeAgentId = req.headers['x-claude-code-agent-id'];

  if (sessionId) {
    // x-claude-code-agent-id present = subagent, value = stable per subagent instance
    // absent = main agent within this session
    let agentKey;
    if (codeAgentId) {
      agentKey = sessionId + ':sub:' + codeAgentId;
    } else {
      agentKey = sessionId + ':main';
    }

    if (agentFingerprints.has(agentKey)) {
      return agentFingerprints.get(agentKey);
    }

    let name;
    if (codeAgentId) {
      name = 'sub:' + codeAgentId.slice(0, 8);
    } else {
      name = 'cc:' + sessionId.slice(0, 8);
    }
    agentFingerprints.set(agentKey, name);
    agentMeta.set(name, { sessionId, isSubagent: !!codeAgentId });
    console.log(`[agent] New agent: ${name}`);
    return name;
  }

  // Priority 3: User-Agent sniff (非 cc 客户端用 anthropic SDK 时, P4 model 拿不到区分度)
  //   例: hermes 用 anthropic SDK, UA = "Anthropic/Python 0.87.0", model = "minimax-m3".
  //   P4 只能拿到 "minimax-m3" — 跟其他用 minimax-m3 的 client 撞一起, 看不出来是 hermes.
  //   P3 拿 UA 主段当 agent 名 → dashboard 显示 "Anthropic-Python", 一眼认出 hermes.
  //
  //   白名单只挡 Claude Code 自家 UA (claude-cli / claude-code), 这俩已经走 P2 了不会到这里.
  //   **不挡** Anthropic-* — 那是 hermes 这种第三方 SDK 用户的真实形态, 必须保留.
  const ua = req.headers['user-agent'];
  if (ua) {
    // 取 UA 前两段, 用 '-' 拼: "Anthropic/Python 0.87.0" → "Anthropic-Python"
    //   "HermesAgent/1.4.2" → "HermesAgent" (没第二段)
    //   "claude-cli/1.0.30 (external, cli)" → "claude-cli-external" (白名单会挡, 不影响)
    const parts = ua.split(/[\/\s()]+/).filter(Boolean);
    const head = parts[0] || '';
    const sub = parts[1] && /^[a-zA-Z]/.test(parts[1]) ? '-' + parts[1] : '';
    const uaKey = (head + sub).trim();
    // 白名单: 只挡 Claude Code 自己的 UA. 其他都允许 (anthropic-sdk 也是 hermes 等客户端的真实形态).
    const CC_UA_PREFIX = ['claude-cli', 'claude-code', 'claude-sdk'];
    const isClaudeCodeUA = CC_UA_PREFIX.some(p => uaKey.toLowerCase().startsWith(p));
    if (uaKey && !isClaudeCodeUA) {
      // 解析 body 取 user_id + 检测 system prompt 是否为 hermes 客户端
      //   Anthropic SDK 默认 UA 撞不到「身份指纹」, 必须从 body 找. hermes 的 system prompt
      //   有两个稳定锚点: "Hermes Agent Persona" / "hermes-agent" skill 提及.
      //   命中 → agent 名直接 "hermes" (短, 一眼认出)
      //   不命中 → fallback 到 uaKey (原行为, 不破坏其他 SDK 用户)
      let userId = '';
      let hermesKind = null;  // 'main' | 'sub' | null
      const parsed = parseJsonBodyCached(req, body);
      if (parsed) {
        userId = (parsed.metadata && parsed.metadata.user_id) || parsed.user_id || '';
        // system 字段可能是 string 也可能是 array<{text}>
        const sys = parsed.system;
        const sysText = typeof sys === 'string' ? sys
          : Array.isArray(sys) ? sys.filter(s => s && s.type === 'text').map(s => s.text).join('\n')
          : '';
        // 主 hermes: 系统提示有 "# Hermes Agent Persona" / "hermes-agent" skill 锚点
        if (sysText.includes('Hermes Agent Persona') || sysText.includes('hermes-agent')) {
          hermesKind = 'main';
        }
        // hermes subagent: 系统提示是 delegate_tool._build_child_system_prompt 构建的
        //   (run_agent.py:684) — 开头固定 "You are a focused subagent working on a specific delegated task."
        //   这是 hermes 内部区分 main 和 sub 的唯一稳定信号 (UA 一样, headers 一样, SDK 不传 metadata)
        else if (sysText.includes('focused subagent working on a specific delegated task')
              || sysText.includes('YOUR TASK:') && sysText.includes('subagent')) {
          hermesKind = 'sub';
        }
      }
      userId = String(userId).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32);

      // 缓存 key 必须按 (UA, userId, kind) 区分 — main 和 sub 各自独立 agent
      const agentKey = 'ua:' + uaKey + (userId ? ':' + userId : ':_') + ':' + (hermesKind || 'unk');
      if (agentFingerprints.has(agentKey)) return agentFingerprints.get(agentKey);

      // agent 命名
      //   main hermes → 'hermes' / 'hermes#<userId>'
      //   sub hermes  → 'hermes:sub' / 'hermes:sub#<userId>'
      //   其他 SDK    → uaKey / uaKey#<userId>
      let name, sessionId, isSubagent;
      if (hermesKind === 'main') {
        name = userId ? `hermes#${userId}` : 'hermes';
        sessionId = `hermes:${userId || '_'}`;
        isSubagent = false;
      } else if (hermesKind === 'sub') {
        name = userId ? `hermes:sub#${userId}` : 'hermes:sub';
        sessionId = `hermes:sub:${userId || '_'}`;
        isSubagent = true;
      } else {
        name = userId ? `${uaKey}#${userId}` : uaKey;
        sessionId = `ua:${uaKey}:${userId || '_'}`;
        isSubagent = false;
      }
      agentFingerprints.set(agentKey, name);
      agentMeta.set(name, { sessionId, isSubagent, ua });
      console.log(`[agent] New agent${hermesKind ? ` (hermes-${hermesKind})` : ' (UA)'}: ${name}`);
      return name;
    }
  }

  // Priority 4: parse body for model name (non-Claude-Code clients)
  const parsed = parseJsonBodyCached(req, body);
  if (parsed && parsed.model) return parsed.model;

  // Fallback: API key based
  if (req.headers['x-api-key'] || req.headers['authorization']) {
    const k = req.headers['x-api-key'] || req.headers['authorization'] || '';
    return 'key:' + k.slice(-6);
  }
  return 'unknown';
}

// 每个流的 per-stream 状态. 流开始时整体替换 (a.stream = freshStreamState(...)),
// 加字段只改这一处 → 零遗漏 (旧实现散落手列, 漏过 streamEndTs/workStartTs → bug).
// 累计字段 (chars/totalTokens/...) 留在 agent 顶层, 跨流保留.
// opts 允许 caller 携带跨流延续信息 (例: WORK 期间 cc 发新流, 主动置 pendingNextRequest
// 推进 WORK→WAITING). 字段在末尾 spread → opts.startTs 等基础字段不会覆盖默认.
function freshStreamState(now, opts = {}) {
  return {
    startTs: now,          // 流开始时刻
    lastDeltaTs: 0,        // 最近 delta 时刻 (0=未收字 → WAITING)
    lastDeltaType: null,   // 'thinking' | 'text' — 驱动 STREAM(think/text)
    phaseStartTs: 0,       // 进入当前 think/text phase 的时刻
    tokens: 0,             // 本流 token 数
    lastOutTokens: 0,      // 本流真实 output_tokens (流结束算真实 tps)
    lastRealTps: 0,        // 上一流真实平均 tps
    stopReason: null,      // 收到的 stop_reason
    stopReasonTs: 0,       // 收到 stop_reason 时刻 = WORK 起始 (路径A 流尾)
    endTs: 0,              // 流结束时刻 = WORK 起始 (路径B, 无 stopReasonTs 时)
    reqTs: now,            // req.on('end') 收 body 时刻. >0 = 已收 cc 请求, 等上游响应头. 配 reqTs→0 标记窗口结束
    sawMessageStart: false,// 本流收到过 message_start (用于 end 时区分上游空流 vs 解析器卡位)
    sawAnyDelta: false,    // 本流收到过 content_block_delta (text_delta/thinking_delta, 注意 input_json_delta 不算)
    sawAnyBlock: false,    // 本流收到过 content_block_start (含 tool_use / text / thinking — 区分"上游本来就没东西给"vs"卡位")
    sawStopReason: false,  // 本流收到过 message_delta.stop_reason (合法无 delta 流都会带这个 — 拒答/纯 tool_use 立刻 close 也走它)
    killedAt: 0,           // killAgentStreams 调用时刻. >0 + openStreams=0 + TTL 内 = DISCONNECTED.
    pendingNextRequest: 0, // WORK 期间 cc 发新流: 主动切 WAITING 而非停留 WORK. 5s 内有效.
    ...opts,
  };
}

function ensureAgent(agentId) {
  const now = Date.now();
  let a = agents.get(agentId);
  if (!a) {
    a = {
      // 累计 (跨流保留)
      chars: 0, deltas: [], requestCount: 0, lastTs: now,
      lastActivityTs: now,  // real output activity (delta/token), NOT request — drives idle cleanup
      totalTokens: 0, inputTokens: 0, lastInputTokens: 0,
      estOutTokens: 0,    // 跨流 tokenizer 估算累计 (countTokens); actualOut=0 时用它估输出
      prompts: [],          // 实时请求 prompt 列表 [{ts,seq,body}], 跟 agent 生灭
      openStreams: 0,       // 活跃 SSE 流计数 (并发流共享)
      // per-stream (每流整体重置, 见 freshStreamState)
      stream: freshStreamState(now),
    };
    agents.set(agentId, a);
  }
  return a;
}

function recordDelta(agentId, text, type) {
  const now = Date.now();
  const a = ensureAgent(agentId);
  const s = a.stream;
  const chars = text.length;
  const tokens = countTokens(text);  // tokenizer 真切 (替代 chars/3.5 死板除法)
  a.chars += chars;
  a.estOutTokens += tokens;          // 跨流估算累计 (actualOut=0 时用)
  if (type) {
    // phase 切换 (含首个 delta): 重置 STREAM 累计时间起点
    if (s.lastDeltaType !== type) s.phaseStartTs = now;
    s.lastDeltaType = type;  // 'thinking' | 'text' — 驱动 STREAM(think)/STREAM(text)
  }
  a.lastTs = now;
  s.lastDeltaTs = now;
  a.lastActivityTs = now;
  s.tokens += tokens;                // 本流 token (纯 tokenizer 估算, 流末不再叠加真实值)
  a.deltas.push({ ts: now, tokens, chars });
  if (a.deltas.length > 60) a.deltas.shift();
}

function recordTokens(agentId, outputTokens, inputTokens) {
  const now = Date.now();
  const a = ensureAgent(agentId);
  const s = a.stream;
  if (outputTokens > 0) {
    a.totalTokens += outputTokens;
    // 不再 s.tokens += outputTokens: s.tokens 全程是 tokenizer 估算 (本流).
    // 真实值走 a.totalTokens (跨流累计) + s.lastOutTokens (流末算真实 tps).
    // 旧实现叠加真实值会导致 s.tokens 虚高 ~2x (估算 + 真实重复).
    s.lastOutTokens = outputTokens;  // 存着, 流结束时算真实平均 tps
    a.lastActivityTs = now;  // output token = real model activity
  }
  if (inputTokens > 0) {
    a.inputTokens += inputTokens;
    // NOT lastActivityTs: input_tokens come from message_start (request side).
    // background requests report them too → must not block cleanup
  }
  a.lastTs = now;
}

function calcAgentStatus(a, now, isSubagent) {
  const s = a.stream;
  // 1s window — matches dashboard refresh rate, SSE is real-time
  const WINDOW = 1000;
  const recent = a.deltas.filter(d => now - d.ts < WINDOW);
  const recentChars = recent.reduce((acc, d) => acc + d.chars, 0);
  const recentTokens = recent.reduce((acc, d) => acc + d.tokens, 0);
  const cps = recentChars; // chars in last 1s = cps directly
  const active = now - a.lastTs < 2000; // 2s grace for active detection

  // estimatedOut: tokenizer 累计估算 (actualOut=0 即还没收到真实 output_tokens 时用)
  const estimatedOut = a.estOutTokens;
  const actualOut = a.totalTokens || 0;
  const actualIn = a.inputTokens || 0;
  const outT = actualOut > 0 ? actualOut : estimatedOut;

  // tps: STREAM 用 tokenizer 估算 (过去 1s 数出的 token 数, 直接即 tps); 流结束用真实平均 (output_tokens ÷ 耗时)
  let tps, tpsEstimated;
  if (a.openStreams > 0) {
    tps = recentTokens;
    tpsEstimated = true;
  } else if (s.lastRealTps > 0) {
    tps = s.lastRealTps;
    tpsEstimated = false;
  } else {
    tps = 0;
    tpsEstimated = false;
  }

  const idleMs = now - a.lastTs;

  // State machine — 纯计算, 只读不改. WORK 时长用事件时间戳 (stopReasonTs/endTs),
  // 这些在数据流入点 (on data / on end) 固定, 不会被新 delta 刷新 → 无需 workStartTs 副作用.
  // STREAM: SSE open + receiving deltas
  // SSE_STUCK: SSE open but no delta for >10s (API/network hung)
  // WORK: stop_reason 收到后 (流尾路径A) 或流刚结束 (路径B) — CC 跑工具
  // IDLE: SSE closed, long time no activity
  // DISCONNECTED: 显式 killAgentStreams 后, 等 cc 重试 (killedAt+TTL 内)
  // PENDING_NEXT_REQUEST 隐式态 (openStreams=0 + pendingNextRequest>0): 推进 WORK→WAITING
  const DISCONNECT_TTL_MS = 60_000;
  const PENDING_NEXT_TTL_MS = 5_000;
  let state = 'IDLE';
  let stateMs = idleMs;
  let streamPhase = null;  // STREAM 子阶段: 'think' | 'text' (其他态 null)
  // DISCONNECTED 优先判: killAgentStreams 写入 killedAt, 60s 内任何 calc 优先返回 DISCONNECTED.
  // 早于 openStreams/endTs 判定, 避免"已 kill 但 s.endTs 还是上次的"误判.
  if (a.openStreams === 0 && s.killedAt > 0 && now - s.killedAt < DISCONNECT_TTL_MS) {
    state = 'DISCONNECTED';
    stateMs = now - s.killedAt;
    return {
      chars: a.chars, cps,
      tokens: actualIn + outT,
      outputTokens: outT,
      inputTokens: actualIn,
      lastInputTokens: a.lastInputTokens,
      tps, tpsEstimated, active, idleMs,
      state, stateMs, streamPhase, openStreams: a.openStreams,
      streamTokens: s.tokens,
      requests: a.requestCount,
    };
  }
  // WORK→WAITING 主动推进: 上一流 WORK 态, cc 已发新请求 (body 已收), 等上游响应头.
  // 比"等 openStreams++ 切 WAITING"早一帧, 避免状态机出现 WORK→WORK→WAITING 抖动.
  if (a.openStreams === 0 && s.pendingNextRequest > 0 && now - s.pendingNextRequest < PENDING_NEXT_TTL_MS) {
    state = 'WAITING';
    stateMs = now - s.pendingNextRequest;
    return {
      chars: a.chars, cps,
      tokens: actualIn + outT,
      outputTokens: outT,
      inputTokens: actualIn,
      lastInputTokens: a.lastInputTokens,
      tps, tpsEstimated, active, idleMs,
      state, stateMs, streamPhase, openStreams: a.openStreams,
      streamTokens: s.tokens,
      requests: a.requestCount,
    };
  }
  if (a.openStreams > 0) {
    const streamDur = now - (s.startTs || now);
    if (s.lastDeltaTs === 0) {
      // SSE open but never received delta — API is thinking
      state = 'WAITING';
      stateMs = streamDur;
    } else {
      const sinceDelta = now - s.lastDeltaTs;
      if (sinceDelta > STREAM_STUCK_MS) {
        state = 'SSE_STUCK';
        stateMs = sinceDelta;
      } else if (s.stopReason) {
        // 已收到 stop_reason = 内容输出完毕, 流即将关闭 (proxyRes end 前的流尾, ~150ms).
        // 流还开着 (openStreams>0) 就不算空闲: end_turn/stop_sequence 保持 STREAM 视觉,
        // 否则这 ~150ms 流尾会闪 idle, 叠加终端渲染延迟 → 用户看到"字还在打却 idle".
        // proxyRes end 后由 endTs>0 分支的 STREAM_TAIL_MS 收尾缓冲继续兜底.
        const ended = (s.stopReason === 'end_turn' || s.stopReason === 'stop_sequence');
        if (ended) {
          state = 'STREAM';
          streamPhase = s.lastDeltaType === 'thinking' ? 'think' : 'text';
          stateMs = sinceDelta;
        } else {
          state = 'WORK';
          // WORK 时长: stop_reason 收到时刻起算 (stopReasonTs 在 on data 固定, 不被新 delta 刷新)
          stateMs = now - (s.stopReasonTs || s.lastDeltaTs || now);
        }
      } else {
        state = 'STREAM';
        stateMs = now - (s.phaseStartTs || s.lastDeltaTs || now);  // think/text 各自从进入本 phase 累计
        streamPhase = s.lastDeltaType === 'thinking' ? 'think' : 'text';
      }
    }
  } else if (s.endTs > 0) {
    const sinceEnd = now - s.endTs;
    if (s.stopReason === 'end_turn' || s.stopReason === 'stop_sequence') {
      // 收尾缓冲: SSE 已 end_turn (proxy 收完回复), 但 cc 终端可能还在渲染刚收完的字
      // (渲染滞后于接收). 此窗内保持 STREAM, 避免"字还在打, mini 却 idle". 见 STREAM_TAIL_MS.
      if (sinceEnd < STREAM_TAIL_MS) {
        state = 'STREAM';
        streamPhase = s.lastDeltaType === 'thinking' ? 'think' : 'text';
        stateMs = sinceEnd;
      } else {
        state = 'IDLE';
        stateMs = sinceEnd;
      }
    } else if (sinceEnd < (isSubagent ? WORK_FOLLOWUP_MS_SUB : WORK_DISPLAY_MS_MAIN)) {
      // tool_use or unknown → CC might be executing tools. main 5min, sub 30s.
      state = 'WORK';
      stateMs = now - (s.stopReasonTs || s.endTs);  // 流尾 stopReasonTs 优先, 无则流结束时刻
    } else {
      state = 'IDLE';
      stateMs = sinceEnd;
    }
  }

  // req→上游响应头窗口: reqTs>0 + 上面所有状态分支都没命中 (openStreams=0, s.endTs=0) → 默认 IDLE
  // 是误判, 升级 WAITING: 用户视角"我刚发了"应见 wait, 不是 idle.
  if (state === 'IDLE' && s.reqTs > 0) {
    state = 'WAITING';
    stateMs = now - s.reqTs;
  }

  return {
    chars: a.chars, cps,
    tokens: actualIn + outT,
    outputTokens: outT,
    inputTokens: actualIn,
    lastInputTokens: a.lastInputTokens,
    tps, tpsEstimated, active, idleMs,
    state, stateMs, streamPhase, openStreams: a.openStreams,
    streamTokens: s.tokens,
    requests: a.requestCount,
  };
}

// 判定 agent 是否"还在工作"：SSE 开 / WORK 窗口内 (流尾 stop_reason=tool_use,
// 等 cc 跑工具期间 proxy 看不到活动 (cc 不发请求), 但 cc 还会回来发下一流.
// 视为 active → 避免 main 被误清. 下一流 freshStreamState() 整体重置, 自然退出 active.
//
// WORK 窗口兜底: 旧版用 30s WORK_FOLLOWUP_MS 兜底被删过 (理由: 长 tool 跑超 30s
// 后 main 仍被误清). 但删了之后 sub-agent WORK 窗口永久 active — sub fork 出去
// 后父 task 结束就成孤儿, stream 永远停在 tool_use → 永不清理. 现在重新引入
// 兜底: main 单独给 10min (避免长 tool 误清), sub 给 IDLE_CLEANUP_MS_SUB (60s,
// sub fork 完基本很快回, 超 60s 没回应就是孤儿).
const WORK_FOLLOWUP_MS_MAIN = 600_000;  // 10min — main 长 tool 容忍窗口
function isAgentActive(a, now, isSubagent) {
  if (a.openStreams > 0) return true;
  const s = a.stream;
  if (s.endTs > 0 && s.stopReason && s.stopReason !== 'end_turn' && s.stopReason !== 'stop_sequence') {
    // 兜底: endTs 后等太久了就当孤儿. sub 用更短窗口 (60s), main 用 10min.
    const followup = isSubagent ? IDLE_CLEANUP_MS_SUB : WORK_FOLLOWUP_MS_MAIN;
    if (now - s.endTs < followup) return true;
  }
  return false;
}

// 同 session 是否还有"还在工作"的 subagent。
// 含本批未过期 + 本批候选 expired 但 active 两种. 后者避免 sub 跑长 tool
// 期间 main 已 idle 超 2min → 同 batch 全清的 bug (旧 hasActiveSub 用 expiredSet
// 过滤掉本批要删的 sub → 保护失效).
//
// 关键: 这里"sub 还活着"用宽窗口 — STREAM (openStreams>0) / 上一活动 (lastTs
// 或 lastActivityTs) 距 now < 10min. 不用 isAgentActive(_, _, true) 那个 60s
// WORK 兜底, 因为那是判 sub 孤儿用的严判, 用这里会让 sub 跑超 60s tool 后
// main 救不回 (本 bug 现场). 父看子要宽松, 父死判孤儿在 pass 0 用 60s 严判,
// 两套阈值分场景, 不冲突.
const SUB_ALIVE_FOR_MAIN_MS = 600_000;  // 10min — main 视角: sub 上次活动 < 此值就当还活着, 救 main
function isSubAliveForMain(a, now) {
  if (a.openStreams > 0) return true;  // STREAM 中 → 必活
  const last = a.lastActivityTs || a.lastTs;
  if (!last) return false;  // 拿不到时间戳 → 当死
  return (now - last) < SUB_ALIVE_FOR_MAIN_MS;
}
function sessionHasActiveSub(sessionId, expiredSet, now) {
  for (const [sid, a] of agents.entries()) {
    if (!agentMeta.get(sid)?.isSubagent) continue;
    if (agentMeta.get(sid).sessionId !== sessionId) continue;
    if (!isSubAliveForMain(a, now)) continue;
    // 即使本批 expired, 只要 active 就保留 (sub 长 tool 期间 main 不能被清)
    return true;
  }
  return false;
}

// 同 session 的 main agent 是否都已长期 idle → sub 没理由继续存活.
// 用于清理"cc 在父 task 里强制 kill sub / 父 task 进程死了但 sub 还在 WORK 窗口".
// WORK 兜底只看了"本 sub 自己 endTs 多久", 没看"父 task 还活着没".
function sessionMainsAllIdle(sessionId, now) {
  let hasMain = false;
  for (const [sid, a] of agents.entries()) {
    const m = agentMeta.get(sid);
    if (!m || m.isSubagent) continue;
    if (m.sessionId !== sessionId) continue;
    hasMain = true;
    // main 还开着流 / 还在 WORK 窗口 → 父 task 还活着
    if (a.openStreams > 0) return false;
    if (isAgentActive(a, now, false)) return false;
    // main idle < 2min → 父 task 可能还在等 sub 回来, 不清 sub
    const idleMs = now - (a.lastActivityTs || a.lastTs);
    if (idleMs < IDLE_CLEANUP_MS_MAIN) return false;
  }
  return hasMain;  // 没 main 算"全员 idle"
}

function buildStatus() {
  const now = Date.now();
  const status = {
    ts: new Date().toISOString(),
    agents: {},
    idleCleanupMsMain: IDLE_CLEANUP_MS_MAIN,
  };
  for (const [id, a] of agents.entries()) {
    const meta = agentMeta.get(id);
    const s = calcAgentStatus(a, now, !!(meta && meta.isSubagent));
    s.sessionId = meta ? meta.sessionId : null;
    s.isSubagent = meta ? meta.isSubagent : false;
    status.agents[id] = s;
  }
  return status;
}

// Manually kill all active SSE streams for an agent. Destroys BOTH ends of the
// pipe (cc↔proxy + proxy↔API) so cc sees a connection reset and its SDK
// auto-retries the request. Returns the number of streams destroyed.
function killAgentStreams(agentId) {
  const set = activeStreams.get(agentId);
  if (!set || set.size === 0) return 0;
  let killed = 0;
  for (const s of set) {
    if (s.closed) continue;
    s.closed = true;
    s.clientAborted = true;  // 见 res.on('close') 同名字段: 抑制 destroy 连锁的"上游流中断"误报
    try { if (s.res && !s.res.destroyed) s.res.destroy(); } catch (e) {}
    try { if (s.proxyReq && !s.proxyReq.destroyed) s.proxyReq.destroy(); } catch (e) {}
    killed++;
  }
  activeStreams.delete(agentId);
  const a = agents.get(agentId);
  if (a) {
    a.openStreams = 0;
    // DISCONNECTED 态判定: killedAt 写入后 60s 内, calcAgentStatus 优先返回 DISCONNECTED.
    // cc 重试发新流时, freshStreamState() 会清掉 killedAt → 自动切 WAITING/STREAM.
    a.stream.killedAt = Date.now();
  }
  console.log(`[kill] agent=${agentId} destroyed ${killed} stream(s)`);
  return killed;
}

// --- ~/.claude/settings.json ANTHROPIC_BASE_URL management ---
// One-click toggle: proxy (monitoring on) <-> previous/direct value (off).
// Only the value is rewritten via regex — every other byte of settings.json is preserved.
// 写入由 src/shared/safe-settings-writer.js 统一守护 (备份/差异保护/原子写/校验回滚),
// 这里只负责 "我要把 baseurl 改成什么" 的业务逻辑.
const { withSafeSettingsWrite } = require('./shared/safe-settings-writer');

applyStateOverrides();

function getSettingsBaseUrl() {
  try {
    const text = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const m = text.match(BASEURL_RE);
    return m ? m[2] : null;
  } catch (e) {
    return null;
  }
}

function setSettingsBaseUrl(newValue) {
  // newValue 转义: 反斜杠 + 双引号 (正则替换只替 value, 不动其它字节)
  const safe = String(newValue).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  withSafeSettingsWrite(SETTINGS_PATH, (text) => {
    if (!BASEURL_RE.test(text)) {
      throw new Error('ANTHROPIC_BASE_URL key not found in settings.json');
    }
    return text.replace(BASEURL_RE, `$1${safe}$3`);
  });
}

function loadMonitorState() {
  // Defaults first, then file values overlay them. New/old/missing files all
  // resolve to a well-shaped object. userDisabled defaults false = "wants
  // monitoring", matching cc-monitor's product intent (monitoring tool).
  try {
    return {
      previousBaseUrl: null,
      userDisabled: false,
      idleCleanupMsMain: 120_000,
      ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')),
    };
  } catch (e) {
    return { previousBaseUrl: null, userDisabled: false, idleCleanupMsMain: 120_000 };
  }
}

// Patch-merge: callers pass only the key(s) they want to change; everything
// else is retained. This makes "exit restore must not touch userDisabled" a
// property of the save mechanism, not caller discipline — restore writes
// { previousBaseUrl: null } and userDisabled survives automatically.
function saveMonitorState(patch) {
  try {
    const merged = { ...loadMonitorState(), ...patch };
    fs.writeFileSync(STATE_PATH, JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {
    console.error('[state] save failed:', e.message);
  }
}

// 读取 cc session 文件 → 提取对话时间线 (用户输入/思考/回复, 不含工具调用与返回)
// cc 会话落盘于 ~/.claude/projects/*/<sessionId>.jsonl (JSONL, 每行一事件, 带 timestamp)
function loadSessionTimeline(sessionId) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let file = null;
  try {
    for (const name of fs.readdirSync(projectsDir)) {
      const p = path.join(projectsDir, name, sessionId + '.jsonl');
      if (fs.existsSync(p)) { file = p; break; }
    }
  } catch (e) { return null; }
  if (!file) return null;

  const MAX = 2000;  // 上限: 防超大 session 撑爆前端
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }

  const entries = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch (e) { continue; }
    const msg = o.message;
    if (!msg || typeof msg !== 'object') continue;
    const ts = o.timestamp || null;
    const c = msg.content;
    if (o.type === 'user' && msg.role === 'user') {
      if (typeof c === 'string') {
        entries.push({ role: 'user', text: c, ts });
      } else if (Array.isArray(c)) {
        // 用户文本块 (粘贴/command), 跳过 tool_result
        for (const b of c) {
          if (b && b.type === 'text' && typeof b.text === 'string') entries.push({ role: 'user', text: b.text, ts });
        }
      }
    } else if (o.type === 'assistant' && msg.role === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'thinking' && typeof b.thinking === 'string') entries.push({ role: 'thinking', text: b.thinking, ts });
        else if (b.type === 'text' && typeof b.text === 'string') entries.push({ role: 'text', text: b.text, ts });
        else if (b.type === 'tool_use') {
          // cc 真实发出的工具调用 (Read/Bash/Edit/Skill 等) + 参数 = "cc 发出去的内容"
          let detail;
          try { detail = JSON.stringify(b.input, null, 2); } catch (e) { detail = String(b.input); }
          entries.push({ role: 'tool_use', name: b.name || '?', text: detail, ts });
        }
      }
    }
    if (entries.length >= MAX) break;
  }
  return { sessionId, count: entries.length, entries };
}

function directBaseUrl() {
  // where cc points when monitoring is OFF (bypass proxy, hit API directly).
  // 优先: state.previousBaseUrl > settings.json (跳过 localhost) > 官方
  const state = loadMonitorState();
  if (state.previousBaseUrl) {
    try {
      const u = new URL(state.previousBaseUrl);
      if (!isProxySelf(u)) return state.previousBaseUrl;
    } catch (e) {}
  }
  const fromSettings = getSettingsBaseUrl();
  if (fromSettings) {
    try {
      const u = new URL(fromSettings);
      if (!isProxySelf(u)) return fromSettings;
    } catch (e) {}
  }
  return 'https://api.anthropic.com';
}

function getBaseUrlStatus() {
  const current = getSettingsBaseUrl();
  const state = loadMonitorState();
  // cc 原本的 baseurl (开监控时被覆盖前的值, 关监控后已恢复 = 同一个值).
  // 监控从未开启 / 未设过 ANTHROPIC_BASE_URL → 走 directBaseUrl() 兜底.
  const originalUrl = state.previousBaseUrl || current || directBaseUrl();
  return {
    monitoring: current === PROXY_BASEURL,
    current,
    previous: state.previousBaseUrl || null,
    originalUrl,
    proxyUrl: PROXY_BASEURL,
    directUrl: directBaseUrl(),
    settingsPath: SETTINGS_PATH,
    settingsKey: 'env.ANTHROPIC_BASE_URL',
  };
}

function enableMonitoring() {
  const current = getSettingsBaseUrl();
  const patch = { userDisabled: false };  // user intent: wants monitoring
  if (current !== PROXY_BASEURL) {
    patch.previousBaseUrl = current; // remember pre-enable value
    setSettingsBaseUrl(PROXY_BASEURL);
  }
  saveMonitorState(patch);
  return getBaseUrlStatus();
}

function disableMonitoring() {
  const target = loadMonitorState().previousBaseUrl || directBaseUrl();
  setSettingsBaseUrl(target);
  saveMonitorState({ previousBaseUrl: null, userDisabled: true });  // user intent: opt out of auto-enable
  return getBaseUrlStatus();
}

// 善后恢复：仅当 settings.json 当前指向代理地址 localhost:PORT
// 且 monitor-state.json 记录过原值时，才写回原值并清空状态。
// 从未开启过监控（previousBaseUrl 为空）→ 一字节不碰，绝不误改用户原始配置。
// 用于退出钩子 + 启动自愈，两处共用（DRY）。
function restoreBaseUrlIfStale() {
  const current = getSettingsBaseUrl();
  const state = loadMonitorState();
  if (current === PROXY_BASEURL && state.previousBaseUrl) {
    setSettingsBaseUrl(state.previousBaseUrl);
    saveMonitorState({ previousBaseUrl: null });
    return { restored: true, previous: state.previousBaseUrl };
  }
  return { restored: false };
}

// Startup auto-enable: monitoring was auto-closed on exit (restoreBaseUrlIfStale),
// so re-open it by default — UNLESS the user explicitly opted out (userDisabled).
// Mirrors restoreBaseUrlIfStale as the second startup-phase action. Failures
// (e.g. settings.json lacks ANTHROPIC_BASE_URL) are caught and logged: dashboard
// still loads and shows monitoring OFF for manual control.
function applyStartupPreference() {
  const { userDisabled } = loadMonitorState();
  if (userDisabled === true) {
    console.log('[startup] monitoring stays OFF (user opted out)');
    return { enabled: false, reason: 'user_disabled' };
  }
  try {
    const status = enableMonitoring();
    console.log('[startup] monitoring auto-enabled');
    return { enabled: true, status };
  } catch (e) {
    console.error('[startup] auto-enable failed:', e.message);
    return { enabled: false, reason: 'enable_failed', error: e.message };
  }
}

// Pre-load static assets at module init (fail fast, no per-request I/O in prod).
const DASHBOARD_PATH = path.join(MONITOR_DIR, 'dashboard.html');
const dashboardHtml = (() => {
  try {
    return fs.readFileSync(DASHBOARD_PATH, 'utf8');
  } catch (e) {
    return '<h1>Dashboard missing</h1><p>src/dashboard.html not found.</p>';
  }
})();

// Dev 热加载: 每次请求读磁盘, 改 dashboard 后刷新即生效. Prod 用上面缓存, 零 I/O.
function serveDashboardHtml() {
  if (!DEV) return dashboardHtml;
  try { return fs.readFileSync(DASHBOARD_PATH, 'utf8'); }
  catch (e) { return dashboardHtml; }
}

// 悬浮窗 mini.html (透明置顶窗口): 同样 dev 热加载 / prod 缓存.
const MINI_PATH = path.join(MONITOR_DIR, 'mini.html');
const miniHtml = (() => {
  try { return fs.readFileSync(MINI_PATH, 'utf8'); }
  catch (e) { return '<h1>mini missing</h1>'; }
})();
function serveMiniHtml() {
  if (!DEV) return miniHtml;
  try { return fs.readFileSync(MINI_PATH, 'utf8'); }
  catch (e) { return miniHtml; }
}

// Collect the full request body into a single Buffer. Returns a promise so callers
// can await it inside the request handler. Caps body size to avoid OOM on runaway
// uploads.
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  // Status endpoint — pure memory, no I/O
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildStatus(), null, 2));
    return;
  }

  // 异常事件流 (SSE 推). 浏览器 EventSource 自动重连. 每次新订阅回放最近 50 条.
  if (req.url === '/events/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const backlog = events.slice(-SSE_EVENT_BACKLOG);
    for (const ev of backlog) {
      try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch (e) { break; }
    }
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { clearInterval(hb); eventClients.delete(res); }
    }, SSE_HEARTBEAT_MS);
    eventClients.add(res);
    req.on('close', () => {
      clearInterval(hb);
      eventClients.delete(res);
    });
    return;
  }
  // 一次性快照 (供 fallback / 测试 / curl)
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: events.length, events: events.slice(-100) }));
    return;
  }
  // 清空 events ring + 通知所有 SSE 订阅者本地清视图.
  // 60s dedupe 窗口随 events.length=0 自然重置, 后续同 type 事件作为新事件出现.
  if (req.url === '/events/clear' && req.method === 'POST') {
    events.length = 0;
    _broadcastClear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cleared: 0 }));
    return;
  }

  // 流请求 SSE: 推送每次 capture ring 完成的请求 summary. 复用 SSE_EVENT_BACKLOG 回放最近 50.
  if (req.url === '/requests/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 升序取末尾 N 条: 旧→新回放, dashboard push 到末尾 → 列表旧在上、新在下,
    // 与实时新请求 append 方向一致. (旧实现降序回放 → 历史倒序, 与实时追加矛盾, 列表乱序)
    const recent = Array.from(captureRing.values()).sort((a, b) => a.ts - b.ts).slice(-SSE_EVENT_BACKLOG);
    for (const e of recent) {
      try { res.write('data: ' + JSON.stringify(_captureSummary(e)) + '\n\n'); } catch (e) { break; }
    }
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { clearInterval(hb); requestClients.delete(res); }
    }, SSE_HEARTBEAT_MS);
    requestClients.add(res);
    req.on('close', () => {
      clearInterval(hb);
      requestClients.delete(res);
    });
    return;
  }
  // 流请求一次性快照 (供 fallback / 测试 / curl)
  if (req.url === '/requests/recent') {
    const list = Array.from(captureRing.values()).sort((a, b) => a.ts - b.ts).slice(-50).map(_captureSummary);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ requests: list }));
    return;
  }
  // 清空 capture ring + 通知流请求 SSE 订阅者本地清视图
  if (req.url === '/requests/clear' && req.method === 'POST') {
    const cleared = captureRing.size;
    captureRing.clear();
    _broadcastRequestClear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cleared }));
    return;
  }

  // Base-url config — toggle ANTHROPIC_BASE_URL in ~/.claude/settings.json
  if (req.url === '/config/baseurl' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getBaseUrlStatus(), null, 2));
    return;
  }
  if (req.url === '/config/baseurl' && req.method === 'POST') {
    const cfgChunks = [];
    req.on('data', c => cfgChunks.push(c));
    req.on('end', () => {
      try {
        const { action } = JSON.parse(Buffer.concat(cfgChunks).toString() || '{}');
        let result;
        if (action === 'enable') result = enableMonitoring();
        else if (action === 'disable') result = disableMonitoring();
        else throw new Error('invalid action (enable|disable)');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }, null, 2));
      } catch (e) {
        console.error('[config]', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Idle cleanup config: GET 当前值 / POST 新值 (单位 ms, dashboard 内部转秒).
  if (req.url === '/config/idle' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ main: IDLE_CLEANUP_MS_MAIN }));
    return;
  }
  if (req.url === '/config/idle' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const main = Number(body.main);
        if (!Number.isFinite(main) || main < 0) throw new Error('main must be a non-negative number');
        const clamped = Math.min(main, _IDLE_CLEANUP_MS_MAX);
        IDLE_CLEANUP_MS_MAIN = clamped;
        saveMonitorState({ idleCleanupMsMain: clamped });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, main: clamped }));
      } catch (e) {
        console.error('[config/idle]', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 调试端点: 立刻跑一轮 cleanup + 把 candidates/saved 全打回来. GET /cleanup/debug
  // 仪表盘触发, 或日志卡住时手动看. 仅暴露结构化快照, 不修改逻辑.
  if (req.url === '/cleanup/debug' && req.method === 'GET') {
    const r = runCleanupPass();
    _logExpired(`debug scanned=${r.scanned} agents=${agents.size}`, r.candidates, r.saved);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      removed: r.removed,
      saved: r.saved.length,
      kept: r.keptAgents,
      scanned: r.scanned,
      remaining: agents.size,
      candidates: r.candidates.map(c => ({
        id: c.id, name: c.name, kind: c.isSubagent ? 'sub' : 'main',
        idleMs: c.idleMs, limit: c.limit, reason: c.subDone ? 'end_turn' : (c.isSubagent ? 'idle_sub' : 'idle_main'),
        stopReason: c.stopReason, openStreams: c.openStreams,
      })),
    }, null, 2));
    return;
  }

  // Manually kill a stuck agent's streams → cc SDK auto-retries the request
  if (req.url === '/agent/kill' && req.method === 'POST') {
    const killChunks = [];
    req.on('data', c => killChunks.push(c));
    req.on('end', () => {
      try {
        const { agentId } = JSON.parse(Buffer.concat(killChunks).toString() || '{}');
        if (!agentId || typeof agentId !== 'string') {
          throw new Error('missing agentId');
        }
        const killed = killAgentStreams(agentId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, killed: killed > 0, streams: killed }));
      } catch (e) {
        console.error('[kill]', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 实时请求 prompt: 返回该 agent 拦截到的所有请求体 (内存, 跟 agent 生灭)
  if (req.url.startsWith('/agent/prompts')) {
    let aid = null;
    try { aid = new URL(req.url, 'http://localhost').searchParams.get('id'); } catch (e) {}
    if (!aid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing id' }));
      return;
    }
    const a = agents.get(aid);
    if (!a) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent 不存在或已被清理' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agentId: aid, count: a.prompts.length, prompts: a.prompts }));
    return;
  }

  // Session 时间线: 读 cc session 文件, 返回对话流 (用户输入/思考/回复)
  if (req.url.startsWith('/session')) {
    let sid = null;
    try { sid = new URL(req.url, 'http://localhost').searchParams.get('id'); } catch (e) {}
    if (!sid || !/^[a-f0-9-]+$/i.test(sid)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid sessionId' }));
      return;
    }
    const result = loadSessionTimeline(sid);
    if (!result) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'session 文件未找到' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 异常事件 HTTP 详情: 按 cid 查 capture ring, 返回脱敏后的 req/resp/SSE 字节流.
  // dashboard 点 ev-row → fetch('/event/detail?cid=...') → 这里取完整原始字节流渲染.
  // 排除 /event/detail/stream (该端点已被前面分支处理, 实时 SSE 推送 delta).
  if (req.url.startsWith('/event/detail') && !req.url.startsWith('/event/detail/stream')) {
    let cidQ = null, hexQ = false;
    try {
      const _u = new URL(req.url, 'http://localhost');
      cidQ = _u.searchParams.get('cid');
      hexQ = _u.searchParams.get('hex') === '1';  // 诊断: ?hex=1 附 sseBytes 原始字节 hex (判乱码成因)
    } catch (e) {}
    // UUID v4: 8-4-4-4-12 = 36 字符. 放宽到 8-64 兼容未来格式.
    if (!cidQ || !/^[a-f0-9-]{8,64}$/i.test(cidQ)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid or missing cid' }));
      return;
    }
    const e = captureRing.get(cidQ);
    if (!e) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'capture 已淘汰或不存在' }));
      return;
    }
    e.lastAccessTs = Date.now();   // LRU read touch
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cid: e.cid, agentId: e.agentId, method: e.method, url: e.url, ts: e.ts,
      req: {
        headers: e.reqHeaders,
        body: e.reqBody ? e.reqBody.toString('utf8') : '',
        bodyTruncated: e.reqBodyTruncated,
        bodySize: e.reqBodySize,
      },
      // SSE 流时也回 resp: statusCode/headers 来自上游响应, body=null (字节在 sse 字段).
      // 这样 SSE 错误类也能在 dashboard "响应" tab 看到上游 HTTP 状态码 / headers.
      resp: {
        statusCode: e.statusCode || null,
        headers: e.respHeaders || {},
        body: e.isSSE ? null : (e.respBody ? e.respBody.toString('utf8') : ''),
        bodyTruncated: e.isSSE ? false : (e.respBodyTruncated || false),
        bodySize: e.isSSE ? 0 : (e.respBodySize || 0),
        isSSE: !!e.isSSE,
      },
      sse: e.isSSE ? {
        bytes: e.sseBytes ? e.sseBytes.toString('utf8') : '',
        // ?hex=1 时附原始字节 hex (诊断乱码成因用; 默认不输出, 避免 800KB→1.6MB 膨胀)
        ...(hexQ && e.sseBytes ? { bytesHex: e.sseBytes.toString('hex') } : {}),
        bytesTruncated: e.sseTruncated,
        bytesSize: e.sseBytesSize,
        // 完整 block 切出时刻 (epoch ms). dashboard 算 block 间隔耗时 (vs 上一个 block).
        blocks: Array.isArray(e.sseBlocks) ? e.sseBlocks.map(b => ({ ts: b.ts })) : [],
      } : null,
      // 同 cid 内全部 recordEvent 诊断快照 (顺序 = recordEvent 调用顺序). 用于 dashboard "诊断详情" tab.
      details: Array.isArray(e.details) ? e.details : [],
    }));
    return;
  }

  // 详情实时 SSE: 订阅��� proxy 切出 content_block_delta 即推, 流结束推 {done:true}.
  // 解决 dashboard 500ms 轮询的"批感", 真正逐字流式. 复用 SSE_HEARTBEAT 心跳.
  // 必须在 /event/detail 之前 — 后者 startsWith('/event/detail') 会截走 /event/detail/stream.
  if (req.url.startsWith('/event/detail/stream')) {
    let cidQ = null;
    try { cidQ = new URL(req.url, 'http://localhost').searchParams.get('cid'); } catch (e) {}
    if (!cidQ || !/^[a-f0-9-]{8,64}$/i.test(cidQ)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid or missing cid' }));
      return;
    }
    const e = captureRing.get(cidQ);
    if (!e) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'capture 已淘汰或不存在' }));
      return;
    }
    e.lastAccessTs = Date.now();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 立即把已收到的 delta 一次性回放 (用户中途打开也能看到已流过的字).
    const past = e.sseBytes ? e.sseBytes.toString('utf8') : '';
    if (past) {
      const blocks = past.split(/\r?\n\r?\n/).filter(Boolean);
      for (const b of blocks) {
        try {
          const _pl = b.split(/\r?\n/);
          let _dn = null; const _dl = [];
          for (const _ln of _pl) {
            if (_ln.startsWith('event:')) _dn = _ln.slice(6).trim();
            else if (_ln.startsWith('data:')) _dl.push(_ln.slice(5).trim());
          }
          if (!_dl.length) continue;
          const _d = _dl.join('\n');
          if (_d === '[DONE]') continue;
          const _o = JSON.parse(_d);
          if (_o.type !== 'content_block_delta') continue;
          const _dd = _o.delta || {};
          if (_dd.type === 'thinking_delta' && _dd.thinking) res.write('data: ' + JSON.stringify({ kind: 'thinking', text: _dd.thinking, ts: 0 }) + '\n\n');
          else if (_dd.type === 'text_delta' && _dd.text) res.write('data: ' + JSON.stringify({ kind: 'text', text: _dd.text, ts: 0 }) + '\n\n');
          else if (_dd.thinking) res.write('data: ' + JSON.stringify({ kind: 'thinking', text: _dd.thinking, ts: 0 }) + '\n\n');
          else if (_dd.text) res.write('data: ' + JSON.stringify({ kind: 'text', text: _dd.text, ts: 0 }) + '\n\n');
        } catch (_) {}
      }
    }
    // 若流已结束, 回放完历史 delta 后立即推 done + 关连接 (不会再有增量).
    if (e._streamEnded) {
      res.write('data: ' + JSON.stringify({ done: true }) + '\n\n');
      res.end();
      return;
    }
    // 注册订阅: 流进行中, proxy 切 part 即推 delta; end/error/close 推 done.
    if (!detailClients.has(cidQ)) detailClients.set(cidQ, new Set());
    detailClients.get(cidQ).add(res);
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (err) { clearInterval(hb); detailClients.get(cidQ)?.delete(res); }
    }, SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(hb);
      const set = detailClients.get(cidQ);
      if (set) { set.delete(res); if (set.size === 0) detailClients.delete(cidQ); }
    });
    return;
  }

  // Dev 热加载: 返回 dashboard 文件 mtime, 前端轮询变化后自动 reload. 生产不挂此端点.
  if (DEV && req.url === '/__dev_mtime__') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mtime: fs.statSync(DASHBOARD_PATH).mtimeMs }));
    } catch (e) {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  // Dev 热加载: 悬浮窗 mini.html mtime
  if (DEV && req.url === '/__dev_mini_mtime__') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mtime: fs.statSync(MINI_PATH).mtimeMs }));
    } catch (e) {
      res.writeHead(404);
      res.end();
    }
    return;
  }

  // 悬浮窗 mini.html
  if (req.url === '/mini.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(serveMiniHtml());
    } catch (e) {
      res.writeHead(404);
      res.end();
    }
    return;
  }

  // Serve dashboard. Dev 模式每次读磁盘(热加载); 生产用启动缓存.
  if (req.url === '/' || req.url === '/index.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(serveDashboardHtml());
    } catch (e) {
      res.writeHead(404);
      res.end('Dashboard not found');
    }
    return;
  }

  // 流请求过滤名单: housekeeping 端点不进 capture / 不转发, 直接 404 兜底 (见 STREAM_REQUEST_BLOCKLIST).
  const reqPath = (req.url || '').split('?')[0];
  if (STREAM_REQUEST_BLOCKLIST.has(reqPath)) {
    res.writeHead(404);
    res.end();
    return;
  }

  // Capture slot 注册: 必须在 req.on('end') 之前完成, 才能让 ts 反映"请求开始"而非"body 收完"时刻.
  // Anthropic 流式 chat: 收到 body 第一字节就开始生成, 响应头可能早于 body 完整上传.
  // 旧实现: ts 在 req.on('end') 内赋值, 响应头比 ts 早 → firstByteAt - ts 出现负数 (firstByteMs 错乱),
  //   且 endAt 用 Date.now() 算的 totalMs 远超流实际时长 (用户报告"15m 但 stream 几秒").
  // 修复: ts 用 Date.now() 立即记录, 整个 capture entry 提前注册; reqBody 在 req.on('end') 填充.
  const cid = require('crypto').randomUUID();
  captureRing.set(cid, {
    cid, ts: Date.now(), lastAccessTs: Date.now(),
    agentId: 'unknown', method: req.method, url: req.url,
    reqHeaders: req.headers,
    reqBody: null, reqBodyTruncated: false, reqBodySize: 0,
    statusCode: 0, respHeaders: null,
    respBody: null, respBodyTruncated: false, respBodySize: 0,
    isSSE: false,
    sseBytes: null, sseTruncated: false, sseBytesSize: 0,
    firstByteAt: null,    // 响应头到达时刻 (HTTP 首字节)
    firstCharAt: null,    // 首字时刻: 第一个 content_block_delta (text/thinking) 到达. SSE 真正的"首字".
    endAt: null,
    details: [],
  });
  _evictCapture();
  // ★ 请求开始即广播 pending summary (statusCode=0) → dashboard 流请求 tab 立刻显示该行
  _broadcastRequest(_captureSummary(captureRing.get(cid)));

  // Collect request body: 全量 buffer, 配合 capture ring 走 LRU 淘汰 (见顶部注释).
  // 不再按字节截断 — copy-as-curl / dashboard SSE 详情需要完整数据.
  const chunks = [];
  let reqBodySize = 0;
  req.on('data', chunk => {
    reqBodySize += chunk.length;
    chunks.push(chunk);
  });
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    const body = bodyBuf.toString();
    const agentId = getAgentId(req, body);
    if (agentId !== 'unknown') {
      const a = ensureAgent(agentId);
      a.requestCount++;
      // 实时存请求 prompt (跟着 agent, agent 清理时随 agents.delete 释放)
      try {
        const parsed = JSON.parse(body);
        a.prompts.push({ ts: Date.now(), seq: a.requestCount, body: parsed });
        if (a.prompts.length > 100) a.prompts.shift();  // 上限: 防超大 session 撑爆内存
      } catch (e) {}
      // Estimate input tokens from request body (API may not report them)
      const estIn = estimateInputTokens(req, body);
      if (estIn > 0) {
        a.inputTokens += estIn;
        a.lastInputTokens = estIn; // track per-request amount for display
        a.lastTs = Date.now();
      }
      // 新流: per-stream 状态整体替换 (零遗漏, 字段集中见 freshStreamState).
      // 旧实现手列字段 → 漏过 streamEndTs/workStartTs → bug. 整体替换根治.
      // WORK 期间 (上一流 endTs>0 + stopReason=tool_use/非 end_turn) cc 发新流 →
      // 主动置 pendingNextRequest → calcAgentStatus 切 WAITING, 不停留在 WORK.
      const prevStop = a.stream.stopReason;
      const prevEnd = a.stream.endTs;
      const isWorkFollowup = prevEnd > 0 && prevStop &&
                             prevStop !== 'end_turn' && prevStop !== 'stop_sequence';
      const newStreamOpts = isWorkFollowup ? { pendingNextRequest: Date.now() } : {};
      a.stream = freshStreamState(Date.now(), newStreamOpts);
    }
    // Forward headers
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k !== 'host') headers[k] = v;
    }
    headers['host'] = API_HOST;

    // cid 已在前面 (req 收到时) 分配并 broadcast pending summary, 这里只补 reqBody / agentId 到 capture entry.
    // ��意: 不重新 randomUUID 也不 captureRing.set, 否则会覆盖 cid, 让之前所有代理响应找不到 entry.
    _log('req', `${req.method} ${req.url} agent=${agentId}`, cid);
    if (cid) {
      const _cap = captureRing.get(cid);
      if (_cap) {
        // agentId 从注册时的占位 'unknown' → body 解析出的真值; 变更则重广播,
        // 让 dashboard 流请求行刷新 agent 列 (非 SSE 请求此后无 chunk/end 广播, 不补则永远 unknown).
        const _agentChanged = _cap.agentId !== agentId;
        _cap.agentId = agentId;
        _cap.reqBody = bodyBuf;
        _cap.reqBodySize = reqBodySize;
        _cap.reqBodyTruncated = false;
        _cap.lastAccessTs = Date.now();
        if (_agentChanged) _broadcastRequest(_captureSummary(_cap));
      }
    }

    const proxyPath = API_PATH_PREFIX + req.url;
    // 声明在 proxyReq 创建前 → response 回调 (if/else) 与 proxyReq.on('error') 均可见.
    // stream: SSE 路径赋值 (activeStreams 追踪 + clientAborted 标记载体); 非 SSE 恒 null.
    // _clientAborted: 非 SSE 路径 cc 打断标记 — 非 SSE 无 stream 对象, 借此独立 flag 抑制连锁上报.
    let stream = null;
    let _clientAborted = false;
    const proxyReq = requestModule.request({
      hostname: API_HOST,
      port: API_PORT,
      path: proxyPath,
      method: req.method,
      headers: headers
    }, (proxyRes) => {
      const ct = proxyRes.headers['content-type'] || '';
      const isSSE = ct.includes('text/event-stream');
      const statusCode = proxyRes.statusCode;
      // 旁路: 响应头已知 status / 是否 SSE → 立即写 capture, 后续广播 (SSE chunk / end) 带上正确值.
      // firstByteAt 同时记录 (= 响应头到达时刻; 非 SSE 的 TTFB. SSE 的 TTFB 取 firstCharAt). 重复 header 回调时不再覆盖.
      if (cid) {
        const _e = captureRing.get(cid);
        if (_e) {
          _e.statusCode = statusCode;
          _e.isSSE = isSSE;
          if (_e.firstByteAt == null) _e.firstByteAt = Date.now();
        }
      }

      // L2 HTTP 错误码监控: 5xx/4xx 分流记录. 2xx 不再进 events (走 capture ring → 流请求 tab).
      if (statusCode >= 400) {
        let evType, sev = 'error';
        if (statusCode === 429) { evType = 'upstream-429'; sev = 'warn'; }
        else if (statusCode === 401 || statusCode === 403) { evType = 'upstream-401'; }
        else if (statusCode >= 500) { evType = 'upstream-5xx'; }
        else { evType = `upstream-${statusCode}`; }
        recordEvent({
          severity: sev, type: evType, agentId,
          message: `上游返回 ${statusCode}${proxyRes.statusMessage ? ' ' + proxyRes.statusMessage : ''}`,
          detail: {
            statusCode, statusMessage: proxyRes.statusMessage,
            retryAfter: proxyRes.headers['retry-after'] || null,
            method: req.method, url: req.url,
          },
        }, cid);
      }

      res.writeHead(statusCode, proxyRes.headers);

      if (isSSE) {
        // Track stream open + register in activeStreams so it can be killed
        // (stream 在外层声明, 见 proxyReq 创建前注释)
        if (agentId !== 'unknown') {
          const a = ensureAgent(agentId);
          a.openStreams++;
          a.stream.reqTs = 0;  // 响应头已回, req→callback 窗口结束
          stream = { res, proxyReq, closed: false, clientAborted: false };
          if (!activeStreams.has(agentId)) activeStreams.set(agentId, new Set());
          activeStreams.get(agentId).add(stream);
        } else {
          // L7 资源: agentId 解析失败, 流进入 SSE 分支但无注册. 提示用户 header 配置异常.
          recordEvent({
            severity: 'notice', type: 'agent-unknown', agentId: null,
            message: '未知 agent (header 解析失败)', detail: {},
          }, cid);
        }
        const unregister = () => {
          if (stream && !stream.closed) {
            stream.closed = true;
            const s = activeStreams.get(agentId);
            if (s) { s.delete(stream); if (s.size === 0) activeStreams.delete(agentId); }
          }
        };
        // L1 连接: 看门狗. 仅检测"流开始后 SSE_WATCHDOG_MS 内连首字都没收到"(真·上游无响应).
        // 首字一到 (下方 content_block_delta 分支) 即清 timer — 否则任何 >60s 的正常长流
        // (思考+长输出) 都会被误报. 流中段卡 (曾有 delta 后续无活动) 由状态机 SSE_STUCK /
        // sse-stuck (warn) 检测, 不归这里管. end/error/close 也会清.
        let _wdTimer = setTimeout(() => {
          if (stream && !stream.closed) {
            recordEvent({
              severity: 'warn', type: 'upstream-timeout', agentId,
              message: `上游无响应 (>${SSE_WATCHDOG_MS / 1000}s 未收到首字)`,
              detail: { stuckMs: SSE_WATCHDOG_MS },
            }, cid);
          }
        }, SSE_WATCHDOG_MS);
        const _clearWd = () => { if (_wdTimer) { clearTimeout(_wdTimer); _wdTimer = null; } };
        // 流开始: 清掉 stopReason dedupe. _lastState 保留 (状态机跨流 diff 需要)
        _lastStopReason.delete(agentId);

        // SSE 类型白名单: 白名单外 → unknown-type 事件 (notice), 不再静默吞
        const KNOWN_SSE_TYPES = new Set([
          'content_block_delta', 'content_block_start', 'content_block_stop',
          'message_start', 'message_delta', 'message_stop',
          'ping', 'error',
        ]);

        // buf = 原始字节 Buffer (旁路累积). 必须字节级, 禁 toString — 跨 chunk 的多字节字符
        // (中文/emoji) 会被 utf8 有损解码成 U+FFFD, 字节永久丢失 → dashboard 实时打印 / SSE
        // 详情出现 "��" 乱码. splitSseEvents 在字节层切完整 event, 每个 event 独立 utf8 解码.
        let buf = Buffer.alloc(0);
        // rawAll = 原始字节全量 (旁路, 仅扫描非法 utf-8 用). buf 被 splitSseEvents 消耗只留尾巴,
        // sseBytes 是 utf8 重建 (非法字节已变 U+FFFD) → 都不能用于字节损坏扫描. rawAll 累全量,
        // 流末扫描后随闭包释放 (不进 capture, 不增长期内存).
        let rawAll = Buffer.alloc(0);
        // capture 用: 累加已被切出的完整 event 块(utf8 string). 流结束时 join 成完整字节流.
        let sseCapturedParts = [];
        let sseCapturedBlocks = [];   // [{ text, ts }]  完整块切出时刻 (相对上一个 block 算耗时)
        let sseBytesSize = 0;       // 原始字节累计 (非 utf-8 字符数), 仅用于前端展示
        let _lastReqBcastTs = 0;    // 流式进度广播节流锚点 (上次广播时刻)
        proxyRes.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          rawAll = Buffer.concat([rawAll, chunk]);  // 旁路: 原始字节全量 (流末扫非法 utf-8)
          sseBytesSize += chunk.length;
          // Debug dump: SSE open + lastDeltaTs=0 持续 > 阈值, 把原始 buf hexdump
          // 出去. 用来判断 chunk 边界是否卡在 CRLF 中间. 默认开, CC_MONITOR_DEBUG=0 关.
          if (DEBUG_DUMP && agentId !== 'unknown') {
            const _a = agents.get(agentId);
            if (_a && _a.openStreams > 0) {
              const _s = _a.stream;
              if (_s.lastDeltaTs === 0 && _s.startTs > 0) debugDumpIfStuck(agentId, _s, buf, 'no_delta', cid);
            }
          }
          // L3 SSE: CRLF 兼容. Anthropic 实际只用 \n\n, 但兼容 CRLF. multi-line
          // data: 续行会自然进入同一个 event (循环内按行收集).
          // 字节层切完整 event (buf=Buffer, 避免 toString 跨 chunk 拆坏多字节字符).
          // parts = utf8 string 数组(无损), rest = 不完整尾巴 Buffer 留下次拼接.
          const { events: parts, rest } = splitSseEvents(buf);
          buf = rest;
          // 把刚切出的完整 parts 也累加到 capture, 避免 pop 机制丢完整 event.
          // ts: 完整块刚切出的时刻, 给 dashboard 算 block 间隔耗时 (vs 上一个 block).
          const cutTs = Date.now();
          for (const p of parts) {
            sseCapturedParts.push(p);
            sseCapturedBlocks.push({ text: p, ts: cutTs });
            // 旁路: 详情实时流推送 — 该 part 若含 content_block_delta.thinking/text 立即推字给订阅者.
            // 单 part 解析 (完整块) 不会跨边界, 安全. 解析失败/非 delta → 静默跳过.
            try {
              const _pl = p.split(/\r?\n/);
              let _dn = null; const _dl = [];
              for (const _ln of _pl) {
                if (_ln.startsWith('event:')) _dn = _ln.slice(6).trim();
                else if (_ln.startsWith('data:')) _dl.push(_ln.slice(5).trim());
              }
              if (!_dl.length) continue;
              const _d = _dl.join('\n');
              if (_d === '[DONE]') continue;
              const _o = JSON.parse(_d);
              if (_o.type !== 'content_block_delta') continue;
              const _dd = _o.delta || {};
              // 首字锚点: delta 必须含实际文本 (text/thinking 非空) 才算. content_block_start / 工具
              // input_json_delta / 空 delta 都没"字" → 不算首字, 不广播.
              let _hasText = false;
              if (_dd.type === 'thinking_delta' && _dd.thinking) { _broadcastDetail(cid, { kind: 'thinking', text: _dd.thinking, ts: cutTs }); _hasText = true; }
              else if (_dd.type === 'text_delta' && _dd.text) { _broadcastDetail(cid, { kind: 'text', text: _dd.text, ts: cutTs }); _hasText = true; }
              else if (_dd.thinking) { _broadcastDetail(cid, { kind: 'thinking', text: _dd.thinking, ts: cutTs }); _hasText = true; }
              else if (_dd.text) { _broadcastDetail(cid, { kind: 'text', text: _dd.text, ts: cutTs }); _hasText = true; }
              if (_hasText) {
                const _cap = captureRing.get(cid);
                if (_cap && _cap.firstCharAt == null) _cap.firstCharAt = cutTs;
                _clearWd();  // 首字到 → 看门狗退场 (流活了, 后续中段无活动由 SSE_STUCK / sse-stuck 接管)
              }
            } catch (e) { /* 非 JSON / 非 delta: 跳过, 不影响 capture */ }
          }
          for (const part of parts) {
            // 解析 event: / data: 字段. multi-line data: 多行拼接.
            const lines = part.split(/\r?\n/);
            let eventName = null;
            const dataLines = [];
            for (const ln of lines) {
              if (ln.startsWith('event:')) eventName = ln.slice(6).trim();
              else if (ln.startsWith('data:')) dataLines.push(ln.slice(5).trim());
            }
            if (dataLines.length === 0) {
              // 没有 data: 行: event:ping 心跳 / event:error / event:* 都走这里
              if (eventName && eventName !== 'ping') {
                recordEvent({
                  severity: 'notice', type: 'event-field', agentId,
                  message: `非 data 事件: ${eventName}`,
                  detail: { eventName },
                }, cid);
              }
              continue;
            }
            const data = dataLines.join('\n');
            if (data === '[DONE]') continue;
            let obj = null;
            try {
              obj = JSON.parse(data);
            } catch (e) {
              // L4 JSON: 解析失败以前静默, 现在上报
              recordEvent({
                severity: 'error', type: 'parse-fail', agentId,
                message: 'SSE data 解析失败',
                detail: { rawPreview: data.slice(0, 200), err: String(e.message || e) },
              }, cid);
              continue;
            }
            // L5 业务: 协议级 error 事件
            if (obj.type === 'error') {
              recordEvent({
                severity: 'error', type: 'event-error-payload', agentId,
                message: 'Anthropic error 事件',
                detail: { error: obj.error || obj },
              }, cid);
              continue;
            }
            // L4 JSON: type 白名单检测
            if (!KNOWN_SSE_TYPES.has(obj.type)) {
              recordEvent({
                severity: 'notice', type: 'unknown-type', agentId,
                message: `未知 SSE 类型: ${obj.type || '(undefined)'}`,
                detail: { type: obj.type || null },
              }, cid);
              continue;
            }
            // 记一下本流收到了什么 event type (供流结束时分流: 上游空流 vs 解析器卡位)
            if (agentId !== 'unknown') {
              const _aa = agents.get(agentId);
              if (_aa) {
                if (obj.type === 'message_start') _aa.stream.sawMessageStart = true;
                if (obj.type === 'content_block_start') _aa.stream.sawAnyBlock = true;
                if (obj.type === 'content_block_delta') _aa.stream.sawAnyDelta = true;
              }
            }
            // Both text deltas and extended-thinking deltas are content_block_delta.
            // delta.type 区分: thinking_delta=思考, text_delta=输出 → STREAM(think)/STREAM(text)
            if (obj.type === 'content_block_delta') {
              const d = obj.delta;
              if (d?.type === 'thinking_delta' && d.thinking) {
                recordDelta(agentId, d.thinking, 'thinking');
              } else if (d?.type === 'text_delta' && d.text) {
                recordDelta(agentId, d.text, 'text');
              } else {
                // 兜底: 旧字段名 / 未知 delta type, 按字段归类
                const t = d?.text ?? d?.thinking;
                if (t) recordDelta(agentId, t, d?.thinking ? 'thinking' : 'text');
              }
            }
            // Track actual token counts
            if (obj.type === 'message_start') {
              _log('usage', `agent=${agentId} usage=${JSON.stringify(obj.message?.usage || obj.usage || 'NONE')}`, cid);
              const u = obj.message?.usage || obj.usage;
              if (u) {
                const inT = u.input_tokens || u.prompt_tokens || u.inputTokens || 0;
                if (inT > 0) recordTokens(agentId, 0, inT);
                const cacheT = u.cache_read_input_tokens || u.cache_read_tokens || 0;
                if (cacheT > 0) recordTokens(agentId, 0, cacheT);
              }
            }
            if (obj.type === 'message_delta') {
              if (obj.delta?.stop_reason) {
                const a = ensureAgent(agentId);
                a.stream.sawStopReason = true;
                a.stream.stopReason = obj.delta.stop_reason;
                a.stream.stopReasonTs = Date.now();  // 收到 stop_reason 时刻 = WORK 起始 (calcAgentStatus 纯读)
                // L5 业务: stop_reason 语义分流. 同 agent 同一 stopReason 60s 内去重.
                const lastSr = _lastStopReason.get(agentId);
                if (lastSr !== obj.delta.stop_reason) {
                  _lastStopReason.set(agentId, obj.delta.stop_reason);
                  const sr = obj.delta.stop_reason;
                  const srMap = {
                    'refusal':    { severity: 'error', type: 'stop-reason-refusal',    msg: '模型拒答 (refusal)' },
                    'overload':   { severity: 'error', type: 'stop-reason-overload',   msg: '上游过载 (overload)' },
                    'max_tokens': { severity: 'warn',  type: 'stop-reason-max-tokens', msg: '输出被截断 (max_tokens)' },
                    'pause_turn': { severity: 'warn',  type: 'stop-reason-pause-turn', msg: '长任务暂停 (pause_turn)' },
                  };
                  const m = srMap[sr];
                  if (m) {
                    recordEvent({
                      severity: m.severity, type: m.type, agentId,
                      message: m.msg, detail: { stopReason: sr },
                    }, cid);
                  }
                }
              }
              if (obj.usage?.output_tokens) {
                const outT = obj.usage.output_tokens || 0;
                if (outT > 0) recordTokens(agentId, outT, 0);
              }
            }
          }
          // 旁路: 同步写 capture 的 SSE 字节 + blocks, 中途点开详情也能看到已收到的块 (end 收尾会补 buf 尾巴).
          // 拼回顺序: 已切完整 parts + 当前 buf 尾巴 (末尾不完整段). 后续 chunk 到达会重写, 不丢已切出的完整 events.
          if (cid) {
            const _e = captureRing.get(cid);
            if (_e) {
              // sseBytes = 已切完整 events 字节 + 分隔符 + buf 尾巴字节. 全程字节级 Buffer 拼接 —
              // 不能 string + Buffer (隐式 toString 会在半字符处产生 U+FFFD, 污染 copy-as-curl 原始字节).
              const _partsBuf = Buffer.from(sseCapturedParts.join('\n\n'), 'utf8');
              const _sepBuf = (sseCapturedParts.length && buf.length) ? Buffer.from('\n\n', 'utf8') : Buffer.alloc(0);
              _e.sseBytes = Buffer.concat([_partsBuf, _sepBuf, buf]);
              _e.sseBlocks = sseCapturedBlocks;
              _e.sseBytesSize = sseBytesSize;
              const _now = Date.now();
              if (_now - _lastReqBcastTs >= REQUEST_BROADCAST_THROTTLE_MS) {
                _lastReqBcastTs = _now;
                _broadcastRequest(_captureSummary(_e));
              }
            }
          }
          res.write(chunk);
        });
        proxyRes.on('end', () => {
          _clearWd();
          unregister();
          if (buf.length > 0) res.write(buf);
          res.end();
          // ★ 旁路取证: 扫原始字节 (rawAll) 非法 utf-8 → 上报「上游字节损坏」+ dump hex.
          //   必须扫 rawAll — sseBytes 是 utf8 重建 (非法字节已变 U+FFFD), 检测不到.
          //   独立于 capture (即便 entry 淘汰也上报). 不动主路径, 不恢复 (字节到 proxy 已坏, 不可逆).
          if (rawAll.length > 0) _scanAndReportCorruption(rawAll, agentId, cid);
          // ★ 写回 capture entry: 标记 SSE 流 + 上游响应头 + 原始字节全量快照.
          //   全量 buffer 配合 capture ring LRU 淘汰 (见顶部注释).
          if (cid) {
            const e = captureRing.get(cid);
            if (e) {
              e.isSSE = true;
              e.statusCode = proxyRes.statusCode;
              e.respHeaders = proxyRes.headers;
              // data 回调已持续同步写 sseBytes/sseBlocks, 这里只标记 truncated=false (流正常 end, 无截断).
              e.sseTruncated = false;
            }
            // 详情流: 末尾 buf 尾巴可能含完整 event (如 message_stop/data delta). 尝试解析 → 推 delta → 推 done.
            // 解析失败/非 delta → 静默, 然后推 done.
            if (buf.length > 0) {
              try {
                const _pl = buf.toString('utf8').split(/\r?\n/);
                let _dn = null; const _dl = [];
                for (const _ln of _pl) {
                  if (_ln.startsWith('event:')) _dn = _ln.slice(6).trim();
                  else if (_ln.startsWith('data:')) _dl.push(_ln.slice(5).trim());
                }
                if (_dl.length) {
                  const _d = _dl.join('\n');
                  if (_d !== '[DONE]') {
                    const _o = JSON.parse(_d);
                    if (_o.type === 'content_block_delta') {
                      const _dd = _o.delta || {};
                      const _ts = Date.now();
                      if (_dd.type === 'thinking_delta' && _dd.thinking) _broadcastDetail(cid, { kind: 'thinking', text: _dd.thinking, ts: _ts });
                      else if (_dd.type === 'text_delta' && _dd.text) _broadcastDetail(cid, { kind: 'text', text: _dd.text, ts: _ts });
                      else if (_dd.thinking) _broadcastDetail(cid, { kind: 'thinking', text: _dd.thinking, ts: _ts });
                      else if (_dd.text) _broadcastDetail(cid, { kind: 'text', text: _dd.text, ts: _ts });
                    }
                  }
                }
              } catch (e) { /* 末尾不完整/非 JSON: 跳过 */ }
            }
            _broadcastDetail(cid, { done: true });
            // ★ 流结束收尾: 设 endAt + 广播最终 summary (dashboard 据此褪色, 否则永远卡橙)
            _finalizeRequestCapture(cid);
          }
          // Track stream end
          if (agentId !== 'unknown') {
            const a = ensureAgent(agentId);
            const s = a.stream;
            // 流结束但 lastDeltaTs 仍 0. 严格分流 (避免误报 tool_use/短 cache/拒答 之类
            // 合法无 delta 流 — 它们都至少带 content_block_start 或 stop_reason):
            //   A) sawMessageStart=true + sawAnyBlock=false + sawStopReason=false
            //      → 上游真发空流 (message_start 后无任何内容直接 close)
            //   B) sawAnyBlock=true 或 sawStopReason=true → 合法无 delta 流
            //      (tool_use / 拒答 / 短 cache / heartbeat 之类), 仅 notice
            //   C) 啥标志都没 + 流持续 > 1s → 真的卡位, warn + dump
            //   D) 啥标志都没 + 流 ≤ 1s → 流太快没机会送, 不报
            if (s.lastDeltaTs === 0 && s.startTs > 0) {
              const durMs = Date.now() - s.startTs;
              if (durMs > 1000) {
                if (s.sawAnyBlock || s.sawStopReason) {
                  // B: 合法无 delta 流. tool_use-only / 拒答 / stop_turn 之类
                  // → notice, 不刷屏. 不 dump (不是卡位).
                  if (!s.sawAnyDelta) {
                    recordEvent({
                      severity: 'notice', type: 'no-delta-tool-only', agentId,
                      message: '流内无文本 delta (tool_use / 拒答 / 短流)',
                      detail: { durMs, bufLen: buf.length, sawAnyBlock: s.sawAnyBlock, sawStopReason: s.sawStopReason, stopReason: s.stopReason },
                    }, cid);
                  }
                } else if (s.sawMessageStart) {
                  // A: 上游真发空流
                  recordEvent({
                    severity: 'warn', type: 'upstream-empty-stream', agentId,
                    message: '上游空流 (message_start 后无内容)',
                    detail: { durMs, bufLen: buf.length },
                  }, cid);
                } else {
                  // C: 啥都没收到 + 流持续 > 1s → 真卡位
                  recordEvent({
                    severity: 'warn', type: 'no-delta-on-close', agentId,
                    message: '整流无 delta, chunk 卡位嫌疑',
                    detail: { durMs, bufLen: buf.length },
                  }, cid);
                  if (DEBUG_DUMP) debugDumpIfStuck(agentId, s, buf, 'no_delta', cid);
                }
              }
              // D) 持续 ≤ 1s 没标志: 静默, 不报
            }
            a.openStreams = Math.max(0, a.openStreams - 1);
            s.endTs = Date.now();  // 流结束时刻 = WORK 起始 (路径B, 无 stopReasonTs 时)
            // 真实平均 tps = 该流真实 output_tokens ÷ 流耗时
            if (s.lastOutTokens > 0 && s.startTs > 0) {
              const durSec = (s.endTs - s.startTs) / 1000;
              if (durSec >= 0.1) s.lastRealTps = Math.round(s.lastOutTokens / durSec);
            }
            // 流 end: 保留 _lastState 让下一流首帧能正确 diff 状态转换 (例 SSE_STUCK→STREAM).
            // _lastState 随 idle cleanup pass 删 agent 时自然释放, 不需手动清.
            _lastStopReason.delete(agentId);
          }
        });
        // Upstream error → unregister (avoid leak)
        proxyRes.on('error', (e) => {
          _clearWd();
          // cc 主动打断 → destroy 上游必然引发此 error (ECONNRESET/EPIPE),
          // 是本次打断的副作用, 非真上游故障. 跳过上报 (client-disconnect 已记录,
          // capture 已由 close 路径收尾). 仅真上游自断 (cc 仍连着) 才报"上游流中���".
          if (stream?.clientAborted) return;
          recordEvent({
            severity: 'error', type: 'upstream-stream-error', agentId,
            message: '上游流中断',
            detail: { err: e?.message || String(e) },
          }, cid);
          unregister();
          if (cid) {
            _broadcastDetail(cid, { done: true });
            // ★ 收尾广播: 缺则 dashboard 该行永远卡橙 (流中断也要褪色)
            _finalizeRequestCapture(cid);
          }
        });
        // client(cc) 断开: 区分「正常 end 后的 close」(proxyRes 已 end → stream.closed, 跳过) vs
        // 「打断」(stream 没 end → 补完整收尾 + 终止上游). 不收尾则 openStreams 不减 → 状态卡 STREAM,
        // 且上游不知 client 断 → 继续吐 delta 空涨 token.
        res.on('close', () => {
          if (stream && !stream.closed) {
            _clearWd();
            // L1 连接: cc 端流未完成就断, 上报 client-disconnect (warn, 非错误)
            recordEvent({
              severity: 'warn', type: 'client-disconnect', agentId,
              message: 'cc 断开 (流未完成)', detail: {},
            }, cid);
            unregister();
            if (agentId !== 'unknown') {
              const a = ensureAgent(agentId);
              a.openStreams = Math.max(0, a.openStreams - 1);
              a.stream.endTs = Date.now();
            }
            // ★ 先打 client 主动断开标记, 再 destroy 上游. destroy 必然引发上游
            // EPIPE/ECONNRESET (proxyRes 'error' + proxyReq 'error'), 那是本次打断的
            // 连锁副作用, 不是真上游故障 → 靠此标记让下方两个 error handler 跳过上报,
            // dashboard 只留 client-disconnect, 不再叠加"上游流中断".
            stream.clientAborted = true;
            try { proxyReq.destroy(); } catch (e) {}  // 终止上游, 停止空涨 delta/token
            if (cid) {
              _broadcastDetail(cid, { done: true });
              // ★ 收尾广播: 缺则 dashboard 该行永远卡橙 (cc 打断也要褪色)
              _finalizeRequestCapture(cid);
            }
          }
        });
      } else {
        // 非 SSE: 手动累 chunks + 同步 res.write, 保留 chunked 流式透传 (每个 chunk
        // 立即转发到客户端, 不等攒齐). 全量 buffer 配合 capture ring LRU 淘汰.
        const _respChunks = [];
        let _respSize = 0;
        let _ended = false;  // proxyRes 正常 end / error 置 true; res close 时仍 false = cc 打断
        proxyRes.on('data', (chunk) => {
          _respSize += chunk.length;
          _respChunks.push(chunk);
          res.write(chunk);
        });
        proxyRes.on('end', () => {
          _ended = true;  // 正常收尾 (含 capture 褪色). 后续 res 'close' 据此识别 = 非打断, 跳过
          if (cid) {
            const e = captureRing.get(cid);
            if (e) {
              e.statusCode = proxyRes.statusCode;
              e.respHeaders = proxyRes.headers;
              e.respBody = Buffer.concat(_respChunks);
              e.respBodyTruncated = false;  // 全量保留, 配合 LRU 淘汰 (见顶部注释)
              e.respBodySize = _respSize;
              if (e.endAt == null) e.endAt = Date.now();  // 非 SSE end 收尾: 设 endAt 供 totalMs 计算
              // ★ 广播到流请求 SSE 订阅者
              _broadcastRequest(_captureSummary(e));
            }
          }
          res.end();
          if (agentId !== 'unknown') ensureAgent(agentId).stream.reqTs = 0;
        });
        // 非 SSE 流中断: 也写 entry (供 client-disconnect 之类的事件能查到)
        proxyRes.on('error', (e) => {
          if (stream?.clientAborted || _clientAborted) return;  // cc 主动打断连锁, 见 SSE 路径注释
          _ended = true;  // 上游真断, 后续 res 'close' 不再当打断处理
          if (cid) {
            const ent = captureRing.get(cid);
            if (ent) {
              ent.statusCode = ent.statusCode || 502;
              ent.respHeaders = ent.respHeaders || proxyRes.headers;
              ent.respBody = ent.respBody || Buffer.from(`proxy stream error: ${e.message}`);
              ent.respBodySize = ent.respBody.length;
            }
            // ★ 收尾广播: 与 SSE 路径一致, 否则 dashboard 该行卡橙
            _finalizeRequestCapture(cid);
          }
          try { res.destroy(); } catch (_) {}
        });
        // cc 主动打断非 SSE 请求 (res close 且 proxyRes 未 end): 收尾 capture 褪色 +
        // destroy 上游停空耗. _clientAborted 抑制上方 proxyRes / proxyReq 连锁 error
        // (否则 destroy 上游必叠一条"上游流中断/连接失败", 与 SSE 打断同病).
        res.on('close', () => {
          if (_ended) return;  // 正常结束后的 close, 跳过
          _clientAborted = true;
          try { proxyReq.destroy(); } catch (_) {}
          if (cid) {
            _broadcastDetail(cid, { done: true });
            _finalizeRequestCapture(cid);  // ★ 收尾广播, 缺则 dashboard 该行卡橙
          }
        });
      }
    });

    proxyReq.on('error', (err) => {
      // cc 主动打断 → res 'close' 路径 destroy 上游, 触发此处 EPIPE/ECONNRESET.
      // 那是本次打断的副作用, 非真上游故障 → 跳过上报 (client-disconnect 已记录).
      // 仅真 TCP / TLS / DNS 失败 (cc 仍连着) 才记 "上游连接失败".
      // stream?.clientAborted = SSE 路径 (含 kill); _clientAborted = 非 SSE 路径 res close 打断.
      if (stream?.clientAborted || _clientAborted) return;
      // L1 连接: TCP / TLS / DNS 失败
      recordEvent({
        severity: 'error', type: 'upstream-tcp-error', agentId,
        message: `上游连接失败: ${err.message || err.code || 'unknown'}`,
        detail: { err: err.message, code: err.code || null },
      }, cid);
      // 旁路: 写终态 — capture 不再 pending, dashboard 不再永远显示 0ms.
      // 上游连接失败 = 502 Bad Gateway, 等同响应头已知. 结束时刻立即落定.
      if (cid) {
        const _e = captureRing.get(cid);
        if (_e) {
          if (_e.statusCode === 0) _e.statusCode = 502;
          if (_e.firstByteAt == null) _e.firstByteAt = Date.now();  // 502 也算一次"首字节"
        }
        _finalizeRequestCapture(cid);
      }
      if (res.socket?.destroyed) return;  // client 已断开打断, destroy 上游触发的 error — 无需写响应
      const _t = new Date().toISOString().slice(11, 19);
      const _c = cid ? ` trace=${cid.slice(0, 8)}` : '';
      console.error(`[${_t}] [ERR]${_c} ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502);
      }
      res.end(JSON.stringify({ error: 'proxy_error', message: err.message }));
      if (agentId !== 'unknown') ensureAgent(agentId).stream.reqTs = 0;  // 上游出错, 取消等待
    });

    // 直接传 Buffer 而非 toString(): 避免 utf-8 解码再编码引入字节变化 (二进制 body 场景).
    if (bodyBuf.length > 0) proxyReq.write(bodyBuf);
    proxyReq.end();
  });
});

// Idle cleanup 自走 timer. 旧实现嵌在 buildStatus() 里, 只在 dashboard 轮询 /status
// 时才跑; 标签页 hidden / 应用未打开 → 轮询停 → 2h+ 不清. 独立 setInterval 解耦.
let _cleanupTimer = null;
const CLEANUP_INTERVAL_MS = 10_000;  // 10s 一轮, 轻量 (纯 Map 遍历 + 几行时间比较)

// 把 expired 详情一次性打出来. pass=1 是"过了 idle 阈值", pass=2 是"main 被
// sessionHasActiveSub 救回来" (sub 还在跑). 命中时按 agent 拆开打, 不混一行,
// 方便 grep / 计数.
function _logExpired(tag, candidates, saved) {
  if (candidates.length === 0) return;
  const lines = candidates.map(c => {
    const kind = c.isSubagent ? 'sub' : 'main';
    const reason = c.orphanReason
      ? c.orphanReason
      : (c.subDone ? 'end_turn' : (c.isSubagent ? 'idle_sub' : 'idle_main'));
    return `  ${c.id}  ${kind}  idle=${(c.idleMs / 1000).toFixed(1)}s  limit=${(c.limit / 1000).toFixed(1)}s  reason=${reason}  stopReason=${c.stopReason || '-'}  name=${c.name || '-'}`;
  });
  console.log(`[cleanup] ${tag} candidates=${candidates.length} saved=${saved.length}`);
  for (const l of lines) console.log(`[cleanup]   ${l}`);
  if (saved.length) {
    for (const s of saved) console.log(`[cleanup]   ↳ kept main ${s.id} (active sub in session ${s.sessionId?.slice(0, 8) || '-'})`);
  }
}

// 单轮清理. 返回 { removed, kept, scanned } 供调用方汇总. _tickCleanup 调,
// 也可单元测试直调.
function runCleanupPass() {
  if (agents.size === 0) return { removed: 0, kept: 0, scanned: 0, candidates: [] };
  const now = Date.now();

  // pass 0: 孤儿 sub 识别. sub 在 WORK 窗口内但同 session main 都长期 idle →
  // 父 task 已经死了/不再回来 (cc 强制 kill sub / 父 task 进程被 kill / session
  // 切换). proxy 收不到任何信号, 只能靠"父都不在了, sub 没理由存活"推断.
  // 命中后强制加入 candidates, 后面的 pass-3 删.
  const orphanForced = [];
  for (const [id, a] of agents.entries()) {
    if (a.openStreams !== 0) continue;
    const m = agentMeta.get(id);
    if (!m || !m.isSubagent) continue;  // 只针对 sub
    if (!isAgentActive(a, now, true)) continue;  // 已经在 WORK 窗口内的
    if (!sessionMainsAllIdle(m.sessionId, now)) continue;
    const idleMs = now - (a.lastActivityTs || a.lastTs);
    orphanForced.push({
      id, idleMs, limit: IDLE_CLEANUP_MS_SUB, name: a.name, isSubagent: true,
      subDone: false, sessionId: m.sessionId, stopReason: a.stream.stopReason,
      openStreams: a.openStreams, orphanReason: 'parent_dead',
    });
  }

  const candidates = [];
  const keptAgents = new Set();
  // pass 0 命中已直接进 candidates (跳过 pass-1 的 isAgentActive 判定)
  for (const o of orphanForced) {
    candidates.push(o);
    keptAgents.delete(o.id);  // 不算 kept
  }
  for (const [id, a] of agents.entries()) {
    if (a.openStreams !== 0) { keptAgents.add(id); continue; }
    const _metaForActive = agentMeta.get(id);
    const _isSub = !!( _metaForActive && _metaForActive.isSubagent);
    if (isAgentActive(a, now, _isSub)) { keptAgents.add(id); continue; }
    const meta = agentMeta.get(id);
    const idleMs = now - (a.lastActivityTs || a.lastTs);
    const subDone = a.stream.stopReason === 'end_turn' || a.stream.stopReason === 'stop_sequence';
    const limit = (meta && meta.isSubagent) ? (subDone ? 0 : IDLE_CLEANUP_MS_SUB) : IDLE_CLEANUP_MS_MAIN;
    if (idleMs > limit) {
      candidates.push({
        id, idleMs, limit, name: a.name, isSubagent: !!(meta && meta.isSubagent),
        subDone, sessionId: meta?.sessionId, stopReason: a.stream.stopReason,
        openStreams: a.openStreams,
      });
    } else {
      keptAgents.add(id);
    }
  }
  // pass 2: main 被同 session 活 sub 救回. orphanForced (sub) 不救 — 父已死.
  const expiredSet = new Set(candidates.map(c => c.id));
  const saved = [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    if (c.isSubagent) continue;  // 只保护 main
    if (c.orphanReason) continue;  // 已被 pass 0 标记为强制清 (理论上 main 不会进 pass 0)
    if (sessionHasActiveSub(c.sessionId, expiredSet, now)) {
      saved.push(c);
      candidates.splice(i, 1);
      keptAgents.add(c.id);
    }
  }
  // pass 3: 真正删除
  for (const c of candidates) {
    agents.delete(c.id);
    activeStreams.delete(c.id);
    agentFingerprints.forEach((v, k) => { if (v === c.id) agentFingerprints.delete(k); });
    agentMeta.delete(c.id);
  }
  return { removed: candidates.length, kept: saved.length, scanned: agents.size + candidates.length, candidates, saved, keptAgents: keptAgents.size };
}

function _tickCleanup() {
  if (agents.size === 0) return;
  // 状态机事件: 每 tick 比对每个 agent 的当前状态 vs 上次, 转换时 emit.
  // 10s 粒度对 SSE_STUCK (>10s) / sse-slow-response (>60s) 足够; 不放 buildStatus 是因为
  // 仪表盘 hidden 时不轮询 → 不 emit. cleanup 自走 timer 解决.
  try {
    const now = Date.now();
    for (const [id, a] of agents.entries()) {
      const meta = agentMeta.get(id);
      const isSub = !!(meta && meta.isSubagent);
      const st = calcAgentStatus(a, now, isSub);
      const prev = _lastState.get(id);
      _emitStateTransition(prev, st.state, id, st);
      _lastState.set(id, st.state);
    }
  } catch (e) {
    console.error('[events] state tick failed:', e.message);
  }
  try {
    const r = runCleanupPass();
    if (r.removed > 0 || r.kept > 0) {
      _logExpired(`tick scanned=${r.scanned} agents=${agents.size}`, r.candidates, r.saved);
    }
  } catch (e) {
    console.error('[cleanup] tick failed:', e.message);
  }
}

function startProxy() {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      console.log(`cc-monitor proxy on :${PORT}`);
      console.log(`Status: http://localhost:${PORT}/status`);
      console.log(`API: ${IS_HTTPS ? 'https' : 'http'}://${API_HOST}:${API_PORT}${API_PATH_PREFIX}`);
      if (!_cleanupTimer) {
        _cleanupTimer = setInterval(_tickCleanup, CLEANUP_INTERVAL_MS);
        // 不 unref 也不关 — 进程退出时由 SIGINT 触发 stopProxy 清掉
      }
      console.log();
      resolve(server);
    };
    server.on('error', onError);
    server.on('listening', onListening);
    // If server was already listening, re-emit the listening event synchronously.
    if (server.listening) {
      onListening();
    } else {
      server.listen(PORT);
    }
  });
}

function stopProxy() {
  return new Promise((resolve) => {
    if (_cleanupTimer) {
      clearInterval(_cleanupTimer);
      _cleanupTimer = null;
    }
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

// 逐个 exports.x = (而非 module.exports = {...}): rollup 的 CJS 插件能静态识别具名导出
exports.startProxy = startProxy;
exports.stopProxy = stopProxy;
exports.restoreBaseUrlIfStale = restoreBaseUrlIfStale;
exports.applyStartupPreference = applyStartupPreference;
exports.getPort = () => PORT;

// 直接跑（node proxy.js）也支持
if (require.main === module) {
  startProxy().catch((err) => {
    console.error('Failed to start proxy:', err);
    process.exit(1);
  });
}
