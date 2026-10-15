# 茄子機台狙擊手

在 Windows 上讀取茄子前台三款遊戲的空桌資訊，挑選「免費遊戲未開至少 50 轉」且未開轉數最高的最多 10 台，透過 Telegram Bot 發到指定群組。固定台北時間每天 **00:00、08:00、10:00、12:00、14:00、18:00、20:00、22:00** 執行。

監控遊戲：戰神賽特二、虎小妹、古神巴風特。

## 一次性設定

1. 安裝 Node.js 22 以上與 Google Chrome，在本目錄執行 `npm ci`。
2. 複製 `.env.example` 為 `.env`，填入 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`。這兩項及 `.auth` 內資料都不會加入 Git。
3. 執行 `npm run login`。程式會開啟專用 Chrome 視窗；首次請自行完成 LINE 登入。程式會從大廳搜尋並進入遊戲。若網站要求「快速轉點」，預設會停止；只有取得同意後以 `npm run login -- --allow-transfer-once` 重跑，才會在這次登入使用畫面預設金額進入。排程不會自動轉點或下注。
4. 執行 `npm run dry-run`，檢查選台結果與訊息格式。確認正確後執行 `npm run run` 發送一次。
5. 執行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-schedule.ps1` 安裝排程。可先加 `-WhatIf` 預覽；要移除時執行 `scripts\remove-schedule.ps1`。

排程任務在目前登入的 Windows 帳戶下執行。電腦需保持開機、網路可用，且此帳戶保持登入；螢幕可以鎖定。主機時區必須是台北。執行紀錄在 `logs/bot.log`。

## 資料與訊息規則

程式使用遊戲頁已登入的連線，呼叫其唯讀的 `getSlotTables` 與 `getSlotTableDetail`，逐頁讀取機台。僅保留狀態為 `Empty` 的機台。機台詳情的 `mgCounts` 依前台畫面依序對應未開、前一、前二轉數。今日與近 30 天百分比依前台得分率欄位計算；這是**得分率**，不是遊戲理論 RTP。

三款遊戲合併排序，跨遊戲取未開轉數最高的 10 台；不足 10 台照實列出。沒有符合條件的空桌時，發送「目前沒有符合條件的空桌」。若任何遊戲讀取失敗，該次任務會報錯且不發送不完整的資訊。

登入網址與工作階段可能過期。如 `logs/bot.log` 出現登入或連線錯誤，重新執行 `npm run login`。若無頭瀏覽器無法載入遊戲，可在 `.env` 設 `HEADLESS=false` 再試跑。

## 主要檔案

- `src/site.js`：遊戲登入網址擷取與房間讀取
- `src/rooms.js`：空桌篩選與排名
- `src/telegram.js`：通知格式與按鈕
- `scripts/install-schedule.ps1`：每日八次的 Windows 排程
