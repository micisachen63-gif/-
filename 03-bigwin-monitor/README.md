# 爆分監控（贏麻／爽爆／茄子）

每 5 分鐘查詢三個後台的注單，單筆出分達門檻就由「小精靈」發到私人風控群組。
贏麻、爽爆的提醒附「📣 發佈到社群」「略過」按鈕（只有群主能按）；按發佈後由該站社群 bot 發恭喜訊息。

## 常用
| 檔案 | 用途 |
|---|---|
| `login.cmd` | 登入過期且自動重新登入失敗時（私人群組會收到「登入失效」）執行：開出 Chrome 視窗，登入三個後台後關閉視窗即可（服務會自動暫停/恢復）。 |
| `status.cmd` | 查看服務、各站最後查詢時間、錯誤 |
| `dry-run.cmd` | 試跑一次，訊息只寫到 `logs\dry-*.txt`，不發 Telegram（服務執行中需先 stop） |
| `stop.cmd` / `start.cmd` | 停止（並停用自動啟動）／恢復 |

指令列：`node src\index.js run-once --dry [--min-pay 5000] [--minutes 10] [--max-alerts 3] [--brands winmalo,songyy,qiezi] [--cdp 9333]`

## 設定 `config.json`
- `brands[].threshold`：單筆出分門檻（贏麻 10000、爽爆 300000、茄子 300000）
- `overlapMinutes`：每次往回重疊查詢的分鐘數。實測爽爆/茄子有注單晚 1–20 分鐘才進後台，所以設 30（去重不會重複通知）。
- 社群 bot 的 token/群組/按鈕網址在執行時從 `營運自動化\.env`、`爽爆機台狙擊手\.env` 讀取；小精靈從 daily_gift 的 `telegram.local.json` 讀取。本專案不存任何 token。

## 出金通知（玩家賣幣給幣商）
- 每 5 分鐘（跟爆分掃描同一輪）讀各站「平台報表 → 收贈禮統計 → 贈禮排行」今天的資料（API `platformSTMT/txnRank`），只看「對象暱稱」是該站幣商、且贈禮方不是幣商的紀錄。
- 同一天同一組（贈禮AID, 對象AID）第一次出現、或「差額／贈禮總金額」有變動時，小精靈發一則「💸 出金通知」到私人群組（無按鈕），附台幣概算（差額 ÷ 匯率）、該玩家今日儲值（台幣，「儲值排行」API `platformSTMT/purchaseRank`，不在榜上顯示 0）、「今日輸贏 = 差額 ÷ 匯率 − 今日儲值」（正＝玩家贏錢、負＝玩家輸錢；金額前加標記：🟢▲ 贏、🔴▼ 輸、⚪ 持平，可在 config.json 的 cashout.winMark / lossMark / evenMark 更換，設成 "" 就不加；今日儲值查詢失敗時不加標記）與「身上金幣剩餘」（會員管理 `player/list` 的目前餘額，只查要通知的玩家）。只有新紀錄或差額／贈禮總金額變動才會通知（差額為負也照發）；今日儲值或餘額變動不會觸發。
- 設定在 `config.json`：`brands[].cashout.dealers`（幣商暱稱）、`brands[].cashout.twdRate`（差額 ÷ 此數 = 台幣）；`cashout.enabled` 設 false 可整個關閉。
- 狀態：`state\cashout.json`（每天每組已通知的金額，保留 3 天；另記錄看到的幣商 AID）。重啟不會重發；發送失敗下一輪自動重試。
- 試跑：`dry-run.cmd --cashout-only`（只跑出金、不發 Telegram；狀態只在記憶體，所以今天的紀錄都會當新紀錄列出）。

## TG 轉話（在私人群組跟助理說話）
不在電腦前時，可在「小精靈的日常回報」群組透過小精靈把話轉給助理（機台數據／新手禮包／營運數據／網頁版GPT）。只有群主（TG id 489706404）在這個群組發的才會轉。

**網頁版GPT（一次登入）**：雙擊 Chrome 圖示的 `開啟GPT專用瀏覽器` 捷徑，在獨立 Chrome 視窗完成 ChatGPT 登入。登入完成後可關閉視窗；收到問題時程式會以同一設定檔在背景開啟。若登入過期或需要人工驗證，再用捷徑開啟可見視窗。此通道使用獨立設定檔，不讀取或修改 GROK 的 webhook／金鑰。面板點「💬 小精靈」後，問題會送到 ChatGPT 網頁，回答完成後以小精靈口吻直接回覆；若送出後等待逾時，程式不會自動重送，以免產生兩份回答。可在回覆提問提示時附上 Telegram 圖片或一般檔案（例如 XLSX、CSV、PDF、DOCX、TXT；上限 20 MB），caption 會當作分析指示；未寫 caption 時會要求 GPT 自動分析及摘要。ChatGPT 產生的圖片會下載原始檔，再以 Telegram 文件傳回，避免照片模式重新壓縮。

**Grok Imagine 影片**：對小精靈下明確指令，例如「生成影片：……」、「幫我生成一支……影片」或附圖後說「把這張圖做成影片」，會自動改走已登入的 Grok Imagine 影片模式；預設 720p、6 秒。處理狀態會持續更新，完成後下載原始 MP4 並以 Telegram 影片傳回同一個群組或私訊。不同人的影片工作會排隊，不會共用或打亂 ChatGPT 對話。這條路徑使用 Grok 網頁帳號的用量，不呼叫 Codex。

所有由 Telegram 小精靈建立的新 ChatGPT 對話都會直接建立在「小精靈對話」專案中，並以該 Telegram 成員的 `@username`（沒有時使用群組顯示名稱）命名。不同使用者仍各自使用獨立頁籤、佇列與對話，提示也會要求只使用目前對話內容，不混用專案內其他人的對話。

**設定（一次）**：雙擊 `設定轉話.cmd` → 輸入助理名稱（Enter = 機台數據）→ 貼上 webhook 網址 → 貼上金鑰（不顯示；前面有 `Bearer ` 會自動去掉）。寫入 `relay.local.json`（本機密檔，不會出現在紀錄或 status；status 只顯示「轉話：已設定 名稱」）。立即生效，不用重啟。要加其他助理就再執行一次輸入另一個名稱。沒有這個檔＝功能關閉（status 顯示「轉話：未設定」）。

**用按鈕（建議）**：群組裡的「🛠 要找誰？」面板（輸入 `/menu` 可再叫出一個）→ 按 💬 小精靈 → 選擇 👥 群組對話或 🔒 私訊對話。Telegram 不允許機器人主動建立首次私訊，因此每位成員只有第一次需要開啟小精靈並按 Start；啟用後可直接在私訊自然傳送文字、圖片或檔案，不必再按 Start、回覆指定訊息或按送出確認。私訊模式的提問、進度、答案與附件都只留在私訊；每位群組成員各自對應不同的 ChatGPT 對話頁籤與上下文，彼此不混用。私訊時會向 Telegram 核對仍為群組成員。群組模式維持預覽及 ✅ 送出流程；其他營運助理按鈕仍僅限群主。未設定的助理按了會提示「尚未設定轉話」。

群主提出本機維修或新增功能時，小精靈會詢問交給 GPT 還是 GROK。每位使用者沿用自己的網頁對話，任務進度保存在 `state/bridge.json`。失敗時追蹤的程式檔會還原，工作草稿留在備份中；傳「繼續」可重新核對並接續。一般聊天可用 `/chat` 開頭。

**用指令（備用）**：`/ask 內容` 或 `/ask@yingma_songbao_qiezi_bot 內容`；開頭加助理名稱可指定對象，例如 `/ask 新手禮包 今天發了沒`，沒寫就是預設助理。小精靈的隱私模式是開的，所以只收得到指令、以及回覆小精靈的訊息（`/問` 需要關閉隱私模式才會生效）。每 15 秒最多轉一則；成功回「📨 已轉給…，稍等回覆」，失敗回「❌ 轉話失敗：原因」。紀錄只記字數，不記內容與金鑰。

**助理怎麼回覆**：把回覆內容寫成 UTF-8 文字檔（例如 `C:\Users\User\Documents\ChatGPT\爆分監控\logs\reply.txt`），在本資料夾執行：
```
node src\tg-say.js --agent 機台數據 --file logs\reply.txt --reply-to <使用者訊息的 message_id>
```
小精靈會以「🤖 機台數據：…」純文字發到私人群組（超過 4000 字自動分段；`--reply-to` 可省略），成功印出 `SENT <message_id>`，失敗會以非 0 結束。它只呼叫 sendMessage，服務執行中也能用。webhook 收到的 JSON：`{ source: "telegram", agent, text, from_id, from_name, chat_id, message_id, sent_at }`（sent_at 為 +08:00 時間），回覆時把 `message_id` 帶進 `--reply-to`。

## 登入
- 後台登入 cookie（laravel_session）不是關閉瀏覽器就失效的類型，而是「2 小時沒使用就過期」；服務每 5 分鐘查詢一次，所以平常會一直保持登入。
- 若仍被登出（例如後台閒置約 2 小時自動登出），服務會自動重新登入（大獎掃描與出金通知共用同一個登入）：
  - 主要方式：用營運程式共用的 DPAPI 加密帳密（`operations-program\private\backend-credentials.dpapi.json`，由 `operations-program\backend-credentials.ps1 -Decrypt -Platform win|song|qz` 解密；路徑在 config.json 的 `backendCredentials.script`）。重新開登入頁 → 點欄位、清空、逐字輸入帳號與密碼 → 確認兩欄都有值 → 按一次「登入」→ 確認離開登入頁且 API 已登入。失敗最多再試一輪（避免帳號被鎖）。帳密只留在記憶體，不寫檔、不寫 log、不截圖、不送 TG；關頁前會先清空欄位。
  - 備援：只有在解密失敗（檔案不存在／平台未設定／無法解密）時，才改用舊方式「點帳號欄位讓 Chrome 自動帶入」（注意：已確認透過 CDP/Playwright 點擊時 Chrome 通常不會自動帶入）。
  - 設 `backendCredentials.enabled` 為 false 可停用帳密登入。
- 自動重新登入連續失敗 2 次，才會在私人群組發一則「登入失效，請登入 XX 後台」（同站 4 小時內最多一則）。

## 架構
- 一個常駐 Node 程序（`src\index.js service`）擁有無畫面 Chrome（設定檔 `.auth\chrome`），每站獨立迴圈查詢，並長輪詢小精靈的按鈕事件。
- 排程：`BigWinMonitor`（登入時）與 `BigWinMonitorWatchdog`（每 5 分鐘）都執行 `scripts\hidden.vbs` → `watchdog.ps1`，服務不在或卡住就（重新）啟動；全程無視窗。
- 狀態：`state\cashout.json`（出金通知）、`state\brands.json`（查詢進度、已通知單號 48 小時）、`state\alerts.json`（按鈕狀態、每筆單號最多發佈一次）、`state\telegram.json`。
- 紀錄：`logs\service.log`（5MB 輪替 ×3）、`logs\watchdog.log`。
- 安裝排程：`powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1 -Force`；移除：`scripts\remove-schedule.ps1`。

### 每日嘻哈推薦（測試版）

小精靈常駐服務會在台灣時間每天 13:30 檢查 32 個已核對的美國嘻哈藝人官方 YouTube 頻道；首次從近 90 天正式音樂影片／音訊依觀看熱度挑最多 30 首，往後只查上次成功檢查以來的新上架（另留 24 小時索引延遲緩衝）。已推薦過的影片不再列出，沒有新曲便不發訊息。群主點「加入歌單」時，程式先核對同名歌單與現有影片，只追加缺少的歌曲；成功後原按鈕改為「我也要聽」，連到同一份不公開歌單，群友只能聽不能修改。

使用獨立 Google Cloud 專案 `fairy-youtube-hip-hop-playlist`。OAuth 用戶端與權杖只存於本機 `.auth/youtube-client.json`、`.auth/youtube-token.json`，不可分享。因目前沒有已驗證網域，Google 專案維持測試模式，授權約 7 天到期；程式提前兩天私訊提醒群主，失效時停止寫入。收到提醒時雙擊 `重新授權YouTube.cmd`，專用 Chrome 會移回畫面內並開啟授權頁；仍須本人手動選帳戶、同意。此功能由既有常駐服務內部計時，不另建 Windows 工作；`config.json` 的 `hiphop.enabled` 可暫停。
- 測試：`npm test`
