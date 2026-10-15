// Keep the dedicated Chrome (CDP 19386 only) off-screen but NOT minimized: Playwright clicks need a real viewport.
// Something (e.g. scripts/authorize-youtube.mjs --open, a crash-restore, the user) can bring the window back on screen,
// so this runs at bot start and before every GPT/Grok browser job (see setBrowserJobPreflight in browser-activity.js).
export const OFFSCREEN_BOUNDS = Object.freeze({ left: -32000, top: -32000, width: 1280, height: 820 });

export function assertDedicatedEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '19386') throw new Error(`dedicated-window refuses ${endpoint} (19386 only)`);
  return url;
}

/** Move every window of the 19386 Chrome off-screen via CDP Browser.setWindowBounds. Returns [{windowId, before}]. */
export async function hideDedicatedWindows({ endpoint = 'http://127.0.0.1:19386', bounds = OFFSCREEN_BOUNDS, timeoutMs = 5000, log, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  const url = assertDedicatedEndpoint(endpoint);
  const version = await (await fetchImpl(`${url.origin}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })).json();
  const ws = new WebSocketImpl(version.webSocketDebuggerUrl);
  let seq = 0; const pending = new Map();
  const timer = setTimeout(() => { for (const p of pending.values()) p.reject(new Error('CDP timeout')); pending.clear(); try { ws.close(); } catch {} }, timeoutMs);
  ws.onmessage = (ev) => { const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result || {}); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP websocket error')); });
    const { targetInfos = [] } = await send('Target.getTargets');
    const windows = new Map();
    for (const t of targetInfos.filter((t) => t.type === 'page')) {
      try { const w = await send('Browser.getWindowForTarget', { targetId: t.targetId }); if (!windows.has(w.windowId)) windows.set(w.windowId, w.bounds || {}); } catch {}
    }
    const moved = [];
    for (const [windowId, before] of windows) {
      if (before.windowState && before.windowState !== 'normal') await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      if (before.left !== bounds.left || before.top !== bounds.top || before.width !== bounds.width || before.height !== bounds.height) {
        await send('Browser.setWindowBounds', { windowId, bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } });
        moved.push({ windowId, before });
      }
    }
    if (moved.length) log?.info?.(`dedicated Chrome moved off-screen: ${moved.map((m) => `#${m.windowId} from ${m.before.left},${m.before.top} ${m.before.windowState || ''}`).join('; ')}`);
    return moved;
  } finally { clearTimeout(timer); try { ws.close(); } catch {} }
}
