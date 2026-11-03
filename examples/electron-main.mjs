// 在 Electron 主进程里直接当 Node 模块用（Electron 33+ 自带的 Node ≥ 22.21 才有 node:sqlite）。
// 渲染进程通过 preload 暴露的 window.uyiMemory.* 调用，见文末。
import { app, ipcMain } from 'electron';
import path from 'node:path';
import { createMemory } from '@pancat/uyi-memory';

let mem;
app.whenReady().then(async () => {
  mem = await createMemory({
    dataDir: path.join(app.getPath('userData'), 'memory'),
    // Key 从桌面端自己的安全存储里取，不要写进代码。getEnv 每次调用都读，改设置不用重启。
    getEnv: () => ({ LLM_PROVIDER: 'openai_compat', LLM_BASE_URL: 'https://api.deepseek.com', LLM_MODEL: 'deepseek-flash', LLM_API_KEY: loadKeyFromKeychain(), LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' })
  });

  // 只开放桌面端需要的方法，一个方法一个通道
  const methods = ['createSpace', 'listSpaces', 'getSpace', 'updateScene', 'deleteSpace', 'syncClock', 'openSession', 'closeSession', 'tick',
    'chat', 'delivered', 'userAction', 'recordEvent', 'events', 'world', 'memory', 'proposeForget', 'confirmForget', 'cancelForget', 'usage'];
  for (const m of methods) ipcMain.handle(`uyi-memory:${m}`, async (_e, ...args) => {
    try { return { ok: true, value: await mem[m](...args) }; }
    catch (e) { return { ok: false, error: { code: e.code || 'ERROR', message: e.message } }; }
  });
});

// 关窗口 = 会话结束；退出前等后台整理跑完
app.on('before-quit', async e => {
  if (!mem) return;
  e.preventDefault();
  for (const s of mem.listSpaces()) if (s.sessionOpen) mem.closeSession(s.id);
  await mem.close();
  mem = null;
  app.quit();
});

function loadKeyFromKeychain() { return process.env.LLM_API_KEY || ''; }

// preload.js:
//   const { contextBridge, ipcRenderer } = require('electron');
//   contextBridge.exposeInMainWorld('uyiMemory', new Proxy({}, { get: (_, m) => (...a) => ipcRenderer.invoke(`uyi-memory:${m}`, ...a) }));
