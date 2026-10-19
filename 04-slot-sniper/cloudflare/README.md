# Cloudflare 掃台容器切換

本目錄讓 Cloudflare Worker 依照台北時段啟動三個互相隔離的瀏覽器容器。GitHub 是程式來源；Workers Builds 部署 Worker，容器目前使用設定檔固定的映像 digest，掃描程式更新須另行建置映像。本機排程在三平台雲端試跑成功前保持啟用。

## 部署前

1. Cloudflare Workers Paid 已啟用。Workers Builds 連接 `micisachen63-gif/-` 的 `main`，專案根目錄為儲存庫根目錄，部署命令為 `npm run deploy:slot-cloud`。
2. Worker 名稱為 `slot-sniper-cloud`。初次部署的 `CLOUD_ENABLED` 為 `false`，因此 Cron 不會執行掃台。
3. 在 Worker Secrets 設定 `ADMIN_KEY`（高強度隨機字串），以及三平台各自的 `SHUANGBAO_TELEGRAM_BOT_TOKEN`、`SHUANGBAO_TELEGRAM_CHAT_ID`、`QIEZI_TELEGRAM_BOT_TOKEN`、`QIEZI_TELEGRAM_CHAT_ID`、`YINGMA_TELEGRAM_BOT_TOKEN`、`YINGMA_TELEGRAM_CHAT_ID`。不得提交到 Git。

## 雲端登入與驗證

1. 開啟 Worker 網址 `/admin`，使用 `ADMIN_KEY` 登入管理頁。
2. 對每個平台按「開始 LINE 登入」，再按「開啟登入畫面」。使用者在雲端 Chrome 畫面親自登入。管理畫面由 Worker 的登入 Cookie 保護；Container 的 VNC 只綁定內部連線。
3. 登入流程完成後按「登入完成後保存狀態」。Cloudflare Container snapshot 會儲存該品牌瀏覽器設定檔。
4. 按「只掃描、不發送」，在狀態頁確認三平台各款遊戲的 `scan.ok` 均為真、`scanned` 與 `selected` 均大於零，且本輪 `last.ok` 為真。此步不送 Telegram；單靠 LINE 登入成功或程序退出碼 0 不代表掃描成功。
5. 在排程時段逐一啟用雲端發送驗證，確認三個品牌 Telegram 群都收到正確訊息，且沒有重複。完成後才把 `CLOUD_ENABLED` 改為 `true`，並停用三個 Windows 排程。

## 費用與維護

- 每個品牌容器以 `standard-1`（4 GiB）啟動；正式掃描完成後閒置 2 分鐘休眠，人工登入畫面保留 30 分鐘。Cloudflare Containers 按使用時間與資源計費，現有 US$10 預算警示只是提醒，不會阻止超額。
- Container snapshot 與映像版本綁定。更新容器映像後可能需要使用者重新登入並保存新的 snapshot；不要在沒有雲端驗證的情況下停用本機備援。
- `wrangler.slot-sniper.jsonc` 目前固定使用已建置的容器映像 digest。推送 GitHub 的掃描程式碼不會自動進入現有容器；更換映像時須重新驗證 LINE 登入、三款掃描與快照。Worker 程式碼仍可獨立部署。
- `CLOUD_ENABLED=false` 是預設保護。排程由 Cloudflare Cron 觸發，不受 GitHub Actions 延遲影響。GitHub 上舊的 `slot-sniper.yml` 排程也保持停用，避免雙重發送。

## 2026-10-19 切換狀態

- 雲端自動排程仍關閉（`CLOUD_ENABLED=false`），Windows 三個排程仍啟用。今天本機最近一次執行三平台各掃描 30 台，均顯示成功。
- 贏麻了雲端 LINE 登入與三款網址擷取完成並已保存快照，但只掃描試跑三款遊戲均在 `getSlotTables` 收到 401，掃描 0 台、未發送。
- 爽爆雲端試跑三款遊戲均未建立可用遊戲連線，掃描 0 台、未發送。
- 茄子雲端第一次試跑三款遊戲均未建立唯讀連線，掃描 0 台、未發送；重新登入與網址擷取完成並保存快照後，第二次試跑三款仍全部未建立唯讀連線，掃描 0 台、未發送。
- 因本機同日可完成掃描，雲端問題集中在雲端遊戲連線／授權階段；401 的確切原因尚未確認。在三平台雲端試跑與 Telegram 發送驗證成功前，不啟用雲端 Cron，也不停用本機排程。
