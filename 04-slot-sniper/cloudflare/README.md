# Cloudflare 掃台容器切換

本目錄讓 Cloudflare Worker 依照台北時段啟動三個互相隔離的瀏覽器容器。GitHub 是程式來源；Cloudflare Workers Builds 從 GitHub 建置 Docker 映像。本機排程在三平台雲端試跑成功前保持啟用。

## 部署前

1. Cloudflare Workers Paid 已啟用。Workers Builds 連接 `micisachen63-gif/-` 的 `main`，專案根目錄為儲存庫根目錄，部署命令為 `npm run deploy:slot-cloud`。
2. Worker 名稱為 `slot-sniper-cloud`。初次部署的 `CLOUD_ENABLED` 為 `false`，因此 Cron 不會執行掃台。
3. 在 Worker Secrets 設定 `ADMIN_KEY`（高強度隨機字串），以及三平台各自的 `SHUANGBAO_TELEGRAM_BOT_TOKEN`、`SHUANGBAO_TELEGRAM_CHAT_ID`、`QIEZI_TELEGRAM_BOT_TOKEN`、`QIEZI_TELEGRAM_CHAT_ID`、`YINGMA_TELEGRAM_BOT_TOKEN`、`YINGMA_TELEGRAM_CHAT_ID`。不得提交到 Git。

## 雲端登入與驗證

1. 開啟 Worker 網址 `/admin`，使用 `ADMIN_KEY` 登入管理頁。
2. 對每個平台按「開始 LINE 登入」，再按「開啟登入畫面」。使用者在雲端 Chrome 畫面親自登入。管理畫面由 Worker 的登入 Cookie 保護；Container 的 VNC 只綁定內部連線。
3. 登入流程完成後按「登入完成後保存狀態」。Cloudflare Container snapshot 會儲存該品牌瀏覽器設定檔。
4. 按「只掃描、不發送」，在狀態頁確認三平台各款遊戲都能掃描到候選機台，且 `last.ok` 為真。此步不送 Telegram。
5. 在排程時段逐一啟用雲端發送驗證，確認三個品牌 Telegram 群都收到正確訊息，且沒有重複。完成後才把 `CLOUD_ENABLED` 改為 `true`，並停用三個 Windows 排程。

## 費用與維護

- 每個品牌容器以 `standard-1`（4 GiB）啟動；正式掃描完成後閒置 2 分鐘休眠，人工登入畫面保留 30 分鐘。Cloudflare Containers 按使用時間與資源計費，現有 US$10 預算警示只是提醒，不會阻止超額。
- Container snapshot 與映像版本綁定。更新容器映像後可能需要使用者重新登入並保存新的 snapshot；不要在沒有雲端驗證的情況下停用本機備援。
- `CLOUD_ENABLED=false` 是預設保護。排程由 Cloudflare Cron 觸發，不受 GitHub Actions 延遲影響。GitHub 上舊的 `slot-sniper.yml` 排程也保持停用，避免雙重發送。
