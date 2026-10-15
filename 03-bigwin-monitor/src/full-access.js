import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { jsonFrom } from './local-maintenance.js';

const DEFAULT_TIMEOUT_MS = 180000;
const MAX_READ_CHARS = 50000;
const MAX_SHELL_OUTPUT = 40000;

export function isFullAccessUser(msg, conf = {}) {
  if (conf.enabled === false) return false;
  const from = msg?.from;
  const chat = msg?.chat;
  if (!from || from.is_bot) return false;
  if (chat?.type !== 'private' || String(chat.id) !== String(from.id)) return false;

  const targetUsername = String(conf.allowedUsername || 'micasachen').replace(/^@/, '').toLowerCase();
  const actualUsername = String(from.username || '').toLowerCase();
  if (actualUsername !== targetUsername) return false;

  if (conf.allowedUserId && String(from.id) !== String(conf.allowedUserId)) return false;
  return true;
}

export function isStopCommand(text = '') {
  return /^(?:\/stop|(?:請|立刻|馬上|先)?(?:停止|取消|中止|停下來|停)(?:一下|執行|目前|這個|這項|任務)*|不要再做了|住手)[！!。\s]*$/i.test(String(text).trim());
}

function resolvePath(targetPath, baseDir) {
  if (!targetPath) return baseDir;
  return path.isAbsolute(targetPath) ? path.normalize(targetPath) : path.resolve(baseDir, targetPath);
}

function backupFile(filePath, backupDir, jobId) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return null;

  const safeRel = filePath.replace(/^[a-zA-Z]:[\\/]/, '').replace(/[\\/]/g, '_');
  const destDir = path.join(backupDir, jobId);
  fs.mkdirSync(destDir, { recursive: true });
  const backupDest = path.join(destDir, `${Date.now()}_${safeRel}`);
  fs.copyFileSync(filePath, backupDest);
  return backupDest;
}

function executePowerShell(command, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, tracker = null) {
  return new Promise((resolve) => {
    const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue'\n${command}`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({ ok: false, code: null, output: err.message });
      return;
    }

    if (tracker) tracker.currentProcess = child;
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > MAX_SHELL_OUTPUT * 2) {
        output = output.slice(-MAX_SHELL_OUTPUT);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      try {
        if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {}
    }, timeoutMs);
    timer.unref?.();

    child.on('close', (code) => {
      clearTimeout(timer);
      if (tracker) tracker.currentProcess = null;
      const finalOut = output.length > MAX_SHELL_OUTPUT ? output.slice(-MAX_SHELL_OUTPUT) : output;
      resolve({ ok: code === 0, code, output: finalOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (tracker) tracker.currentProcess = null;
      resolve({ ok: false, code: null, output: err.message });
    });
  });
}

export function createFullAccessAgent({
  chatFor,
  baseDir = process.cwd(),
  backupDir = path.join(process.cwd(), 'backup', 'full-access'),
  maxSteps = 25,
  log,
  api = null
} = {}) {
  const activeJobs = new Map();

  async function executeTool(job, call, chatId) {
    const tool = String(call.tool || '').trim();
    if (tool === 'read_file') {
      const target = resolvePath(call.path, baseDir);
      if (!fs.existsSync(target)) throw new Error(`檔案不存在：${target}`);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) throw new Error(`目標是資料夾不是檔案：${target}`);
      const offset = Number(call.offset) || 0;
      const limit = Number(call.limit) || MAX_READ_CHARS;
      const raw = fs.readFileSync(target, call.encoding || 'utf8');
      const slice = raw.slice(offset, offset + limit);
      return { ok: true, path: target, size: stat.size, content: slice, hasMore: offset + limit < raw.length };
    }

    if (tool === 'write_file') {
      const target = resolvePath(call.path, baseDir);
      const bak = backupFile(target, backupDir, job.id);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const content = String(call.content ?? '');
      if (call.append) {
        fs.appendFileSync(target, content, call.encoding || 'utf8');
      } else {
        fs.writeFileSync(target, content, call.encoding || 'utf8');
      }
      return { ok: true, path: target, bytes: Buffer.byteLength(content), backup: bak };
    }

    if (tool === 'replace_text') {
      const target = resolvePath(call.path, baseDir);
      if (!fs.existsSync(target)) throw new Error(`檔案不存在：${target}`);
      const bak = backupFile(target, backupDir, job.id);
      const expected = String(call.expected ?? '');
      const replacement = String(call.replacement ?? '');
      const old = fs.readFileSync(target, 'utf8');
      const count = old.split(expected).length - 1;
      if (count !== 1) throw new Error(`預期文字出現 ${count} 次，必須恰好為 1 次才能精準替換`);
      fs.writeFileSync(target, old.replace(expected, replacement), 'utf8');
      return { ok: true, path: target, backup: bak };
    }

    if (tool === 'delete_file') {
      const target = resolvePath(call.path, baseDir);
      if (!fs.existsSync(target)) return { ok: true, path: target, note: '檔案原本即不存在' };
      const bak = backupFile(target, backupDir, job.id);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.unlinkSync(target);
      }
      return { ok: true, path: target, backup: bak };
    }

    if (tool === 'list_directory') {
      const target = resolvePath(call.path || '.', baseDir);
      if (!fs.existsSync(target)) throw new Error(`資料夾不存在：${target}`);
      const entries = fs.readdirSync(target, { withFileTypes: true });
      const items = entries.slice(0, call.maxEntries || 200).map((e) => {
        const full = path.join(target, e.name);
        let size = 0;
        let mtime = null;
        try {
          const st = fs.statSync(full);
          size = st.size;
          mtime = st.mtime.toISOString();
        } catch {}
        return { name: e.name, isDirectory: e.isDirectory(), size, mtime };
      });
      return { ok: true, path: target, total: entries.length, items };
    }

    if (tool === 'file_stat') {
      const target = resolvePath(call.path, baseDir);
      if (!fs.existsSync(target)) return { ok: true, exists: false, path: target };
      const st = fs.statSync(target);
      return { ok: true, exists: true, path: target, isDirectory: st.isDirectory(), size: st.size, mtime: st.mtime.toISOString() };
    }

    if (tool === 'make_directory') {
      const target = resolvePath(call.path, baseDir);
      fs.mkdirSync(target, { recursive: true });
      return { ok: true, path: target };
    }

    if (tool === 'copy_file' || tool === 'move_file') {
      const src = resolvePath(call.source, baseDir);
      const dest = resolvePath(call.destination, baseDir);
      if (!fs.existsSync(src)) throw new Error(`來源路徑不存在：${src}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      backupFile(dest, backupDir, job.id);
      if (tool === 'copy_file') {
        fs.copyFileSync(src, dest);
      } else {
        fs.renameSync(src, dest);
      }
      return { ok: true, source: src, destination: dest };
    }

    if (tool === 'run_shell') {
      const cwd = call.cwd ? resolvePath(call.cwd, baseDir) : baseDir;
      const res = await executePowerShell(call.command, cwd, call.timeoutMs || DEFAULT_TIMEOUT_MS, job);
      return { ok: res.ok, code: res.code, output: res.output };
    }

    if (tool === 'send_file_to_telegram') {
      const target = resolvePath(call.path, baseDir);
      if (!fs.existsSync(target)) throw new Error(`檔案不存在：${target}`);
      if (!api || !chatId) throw new Error('Telegram 發送功能不可用');
      const st = fs.statSync(target);
      if (st.size > 45 * 1024 * 1024) throw new Error(`檔案過大（${st.size} bytes），超過 Telegram 上傳限制`);
      const buffer = fs.readFileSync(target);
      const fileName = path.basename(target);
      await api.sendDocument({
        chatId,
        buffer,
        fileName,
        caption: call.caption || `本機檔案：${fileName}`
      });
      return { ok: true, path: target, size: st.size, sent: true };
    }

    throw new Error(`未知的工具名稱：${tool}`);
  }

  const protocol = `你是群主 @micasachen 專屬的最高權限本機系統代理，由 ChatGPT 網頁版擔任大腦。
【重要架構說明】：
本協定是「外部工具代理協定」：這些本機工具是由外部 Node.js 宿主程式在 Windows 電腦直接執行，【不會】出現在 ChatGPT 網頁工具列中。
你不需要也不會在瀏覽器端擁有本機執行環境，你只要回傳 status="tool" 的 JSON 物件，外部宿主程式就會在 Windows 實際執行你指定的工具，並在下一回合將【真實執行結果】（LOCAL_TOOL_RESULT_BATCH）送回給你。
因此：
1. 嚴禁宣稱「沒有掛載本機工具」、「沒有權限讀寫 C 槽」、「請上傳專案 ZIP」或「需要連接本地 Agent」。外部宿主代理已經完整運行並隨時待命！
2. 面對使用者的本機需求，先規劃並呼叫工具（例如 list_directory、read_file 或 run_shell）調查；若缺少必需的使用者決定，可先回傳 status="question"。
3. 嚴禁在尚未實際呼叫任何工具前直接回傳 status="complete"。
4. 只能輸出一個嚴格合法的 JSON 物件，放在單一 \`\`\`json 程式碼區塊中。絕對不要在程式碼區塊外輸出任何其他普通文字或解釋。
5. 若需要使用者決定或補充資訊，回傳 status="question"，以繁體中文白話提出一個具體問題；外部代理會把問題傳到 Telegram，等使用者回答再交還給你。不要叫使用者去網頁查看 JSON 或程式碼。等待回答期間不得繼續呼叫工具。

工具清單：
1. list_directory {path?, maxEntries?}：列出資料夾內容（包含目錄結構、檔案大小與修改時間）
2. read_file {path, offset?, limit?, encoding?}：讀取檔案文字或程式碼內容
3. write_file {path, content, append?, encoding?}：整檔建立/覆寫或追加寫入（修改前自動留有備份）
4. replace_text {path, expected, replacement}：精確取代檔案內文字（需剛好命中一次）
5. delete_file {path}：刪除檔案或資料夾（刪除前自動留有備份）
6. copy_file {source, destination}：複製檔案
7. move_file {source, destination}：移動或重新命名檔案
8. make_directory {path}：建立資料夾
9. file_stat {path}：檢查檔案或資料夾狀態與大小
10. run_shell {command, cwd?, timeoutMs?}：在 Windows 執行 PowerShell 指令並取得輸出（最高權限，無黑名單）
11. send_file_to_telegram {path, caption?}：將本機檔案直接透過 Telegram 傳送給使用者

呼叫格式：
\`\`\`json
{
  "status": "tool",
  "progress": "簡短的一句話進度說明",
  "calls": [
    { "tool": "list_directory", "path": "C:\\\\Users\\\\User\\\\Documents\\\\ChatGPT\\\\爆分監控" }
  ]
}
\`\`\`
每回合可在 calls 放入 1 到 6 個可連續執行的動作。

需要詢問使用者時格式：
\`\`\`json
{ "status": "question", "question": "請用白話說明要使用者決定什麼？", "why": "這會影響什麼？", "options": ["選項一", "選項二"] }
\`\`\`

任務完成時格式（必須在真實執行工具並確認結果後）：
\`\`\`json
{
  "status": "complete",
  "summary": "以親切清晰的繁體中文總結完成的工作與各項檔案處理結果"
}
\`\`\``;

  async function runJob({ text, userId, onProgress, conversationTitle, chatId, images = [], files = [] }) {
    const existing = activeJobs.get(String(userId));
    if (existing && !existing.aborted) {
      return { text: `任務仍在處理中：${existing.lastProgress || '正在等待網頁模型回應'}` };
    }

    const jobId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id: jobId,
      userId,
      chatId,
      currentProcess: null,
      aborted: false,
      pendingQuestion: null,
      lastProgress: '啟動中'
    };
    job.abortPromise = new Promise((_, reject) => { job.abortWait = reject; });
    job.abortPromise.catch(() => {});
    activeJobs.set(String(userId), job);

    const chat = chatFor(String(userId), 'gpt');
    let prompt = `${protocol}\n\n任務編號：${jobId}\n使用者需求：\n${text}\n\n請輸出第一步 JSON：可用 status="tool" 調查，必要時用 status="question" 向使用者釐清；不要輸出其他文字。`;
    let lastProgress = '正在分析需求並規劃執行步驟';
    let executedAnyTool = false;
    let formatRetries = 0;

    try {
      for (let step = 1; step <= maxSteps; step++) {
        if (job.aborted) throw new Error('任務已被使用者中止');
        job.lastProgress = lastProgress;
        await onProgress?.(`進度 (${step}/${maxSteps})：${lastProgress}`);

        const answer = await Promise.race([chat.ask(prompt, {
          onProgress: (p) => !job.aborted && onProgress?.(`進度 (${step}/${maxSteps})：${p}`),
          conversationTitle: conversationTitle || '@micasachen',
          toolMode: true,
          images: step === 1 ? images : [],
          files: step === 1 ? files : []
        }), job.abortPromise]);

        if (job.aborted) throw new Error('任務已被使用者中止');

        let call;
        try {
          call = jsonFrom(answer);
          formatRetries = 0;
        } catch {
          formatRetries++;
          if (formatRetries > 2) {
            throw new Error(`GPT 未回傳合法 JSON 工具格式：${String(answer || '').slice(0, 100)}`);
          }
          await onProgress?.('回傳格式校正中…');
          prompt = 'FORMAT_ERROR：本機代理未執行任何動作。外部守護行程正在等待你的工具指令。請勿輸出普通文字，立刻以單一 ```json 程式碼區塊輸出 {"status":"tool", "progress":"...", "calls":[...]} 以調用本機工具開始執行。';
          continue;
        }

        if (call.status === 'complete') {
          if (!executedAnyTool && /沒有.*掛載|無法.*(讀取|存取|執行|操作|本機)|未掛載|沙盒|需要.*(掛載|連接|上傳)|不能假裝/i.test(call.summary || '')) {
            await onProgress?.('提示代理調用工具中…');
            prompt = '【系統指示】：外部本機代理已經就緒！你的 JSON 指令會由外部守護程序直接於 Windows 系統執行。請立即輸出 status="tool" 的 JSON 區塊呼叫 list_directory 或 read_file 開始檢視使用者指定的路徑，嚴禁拒絕或回傳 complete。';
            continue;
          }
          const summary = call.summary || '處理完成';
          return { text: `✅ 小精靈本機執行完畢：\n\n${summary}` };
        }

        if (['question', 'ask_user', 'clarification'].includes(call.status)) {
          const question = String(call.question || call.prompt || call.message || '').trim().slice(0, 1800);
          if (!question) throw new Error('GPT 要求詢問使用者，但沒有提出具體問題');
          if (!api || !chatId) throw new Error('無法把 GPT 的問題送到 Telegram');
          const why = String(call.why || '').trim().slice(0, 700);
          const options = Array.isArray(call.options) ? call.options.slice(0, 5).map(x => String(x).trim()).filter(Boolean) : [];
          const lines = [`❓ 小精靈需要你回答`, question];
          if (why) lines.push(`原因：${why}`);
          if (options.length) lines.push(`可選：${options.join('／')}`);
          lines.push('直接回覆這則訊息即可繼續；輸入「停止」可中止任務。');
          let acceptReply;
          const replyPromise = new Promise(resolve => { acceptReply = resolve; });
          const pending = { question, acceptReply, messageId: null };
          job.pendingQuestion = pending;
          try {
            const sent = await api.call('sendMessage', { chat_id: chatId, text: lines.join('\n\n'), reply_markup: { force_reply: true, input_field_placeholder: '請回答小精靈的問題' } });
            pending.messageId = sent?.message_id ?? null;
            job.lastProgress = `等待你回答：${question.slice(0, 90)}`;
            try { await onProgress?.('等待你在 Telegram 回答問題'); }
            catch (error) { log?.warn?.(`question progress update failed: ${error.message}`); }
            const reply = await Promise.race([replyPromise, job.abortPromise]);
            if (job.aborted) throw new Error('任務已被使用者中止');
            prompt = `USER_REPLY_TO_QUESTION\n問題：${question}\n使用者回答：${reply}\n請依回答繼續原任務，回傳下一步 JSON。`;
            lastProgress = '已收到回答，繼續原任務';
          } finally { job.pendingQuestion = null; }
          continue;
        }

        if (call.status !== 'tool') {
          throw new Error(`非預期的狀態：${call.status}`);
        }

        const calls = Array.isArray(call.calls) ? call.calls : [call];
        if (!calls.length) throw new Error('沒有指定任何工具呼叫');

        lastProgress = call.progress || `正在執行 ${calls.length} 項本機操作`;
        await onProgress?.(`進度 (${step}/${maxSteps})：${lastProgress}`);

        const results = [];
        for (let i = 0; i < calls.length; i++) {
          if (job.aborted) throw new Error('任務已被使用者中止');
          const item = calls[i];
          let res;
          try {
            res = await executeTool(job, item, chatId);
            executedAnyTool = true;
          } catch (err) {
            res = { ok: false, error: err.message };
          }
          results.push({ index: i + 1, tool: item.tool, result: res });
          if (res.ok === false) break;
        }

        if (step === maxSteps - 1) {
          prompt = `LOCAL_TOOL_RESULT_BATCH\n${JSON.stringify(results, null, 2)}\n\n【重要提示：下一回合為本輪執行上限第 ${maxSteps} 步】：請勿再發起新的工具操作，請依據目前為止所有調查與修改結果，回傳 status="complete" 的 JSON 輸出完整總結與成果報告！`;
        } else {
          prompt = `LOCAL_TOOL_RESULT_BATCH\n${JSON.stringify(results, null, 2)}\n請根據上述結果回傳下一步 JSON。若已全數完成請回傳 status=complete。`;
        }
      }
      return { text: `✅ 小精靈本機階段性執行完畢（已達單次上限 ${maxSteps} 步）：\n\n最新進度：${lastProgress}\n\n所有修改與測試皆已保留；如需繼續深入處理或總結，可直接在對話中輸入「繼續」或「請總結成果」。` };
    } catch (err) {
      log?.error?.(`full-access job ${jobId} failed: ${err.message}`);
      return job.aborted ? { text: '🛑 任務已停止；後續本機操作不會繼續執行。', cancelled: true } : { text: `⚠️ 小精靈處理未完成：${err.message}` };
    } finally {
      activeJobs.delete(String(userId));
    }
  }

  function stopJob(userId) {
    const job = activeJobs.get(String(userId));
    if (!job) return false;
    job.aborted = true;
    job.pendingQuestion = null;
    job.abortWait?.(new Error('任務已被使用者中止'));
    if (job.currentProcess?.pid) {
      try {
        spawn('taskkill', ['/PID', String(job.currentProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {}
    }
    return true;
  }

  function isRunning(userId) {
    return activeJobs.has(String(userId));
  }

  function currentStatus(userId) {
    return activeJobs.get(String(userId))?.lastProgress || null;
  }

  function awaitingReply(userId) {
    return Boolean(activeJobs.get(String(userId))?.pendingQuestion);
  }

  function reply(userId, text) {
    const job = activeJobs.get(String(userId));
    const pending = job?.pendingQuestion;
    if (!pending || job.aborted || !String(text || '').trim()) return false;
    job.pendingQuestion = null;
    pending.acceptReply(String(text).trim());
    return true;
  }

  return {
    run: runJob,
    stop: stopJob,
    isRunning,
    currentStatus,
    awaitingReply,
    reply
  };
}
