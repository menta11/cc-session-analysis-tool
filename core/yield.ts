/**
 * 让出一次事件循环 —— 供「长时间循环里保持宿主可响应」使用。
 *
 * 为什么不直接写 `setImmediate`：它是 **Node/IE 专有**全局，不是 Web 标准。Tauri 渲染层跑在系统
 * WebView 里（macOS WKWebView / Windows WebView2）没有它，裸用会抛 `ReferenceError`，而
 * 「让出事件循环」这个动作通常位于长循环内部、Promise executor 里 —— 异常直接把整条调用链
 * reject 掉（`scanProjects` 因此在第一个文件上整体失败）。
 *
 * `setTimeout` 两边都有，且是消息任务（macrotask）：浏览器能在两次调用之间完成渲染/响应输入。
 *
 * 代价：浏览器对嵌套定时器有最小间隔夹取（嵌套 ≥5 层后按 ≥4ms 计）。所以调用方**按批次**让出，
 * 不要逐个元素调用 —— 上千个文件逐个让出会白烧几秒。批大小由调用方按「单位工作量」决定。
 */
export function yieldToHost(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}
