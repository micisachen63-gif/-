# 🤖 回家後給 AI 的無縫接管提示詞 (AI Handover Prompt)

請在回家打開 Antigravity 或 Codex 後，直接將以下內容複製貼給 AI：

```markdown
你好！我是專案開發者。今天我在公司電腦已經完成了兩大專案的打包與雲端化：

1. 【專案一：星穹旅誌 (Star Journal RPG)】
   - 倉庫：https://github.com/micisachen63-gif/--MiniApp.git
   - 包含：Cloudflare MiniApp、D1 資料庫、Telegram Cloud Bot (Webhook 模式)、單元測試與素材。

2. 【專案二：營運自動化全套組 (Ops Automation)】
   - 倉庫：https://github.com/micisachen63-gif/-.git
   - 包含：營運數據表 (08:00)、新手禮包 (07:00)、爆分監控 (5分鐘)、撿台機器人 (定時選台)、社群小精靈。

【重要環境與網路認知】：
- 公司產品後台 (admin.winmalo.com / admin.qzplays.com:9032) 有嚴格的 IP 白名單防火牆（只允許公司 IP 202.39.33.47）。平時我透過「遠端桌面」連回公司電腦。
- 撿台機器人連線的 ATG 遊戲伺服器 (play.godeebxp.com) 與 Telegram Bot 則是全球暢通、完全不受白名單限制。
- 爆分監控已經實測逆向出純 API 登入接口 (POST :9032/api/login)，免開 Chrome 即可執行。

請讀取專案內的 `README.md` 與 `docs/HOME_DEPLOYMENT_GUIDE.md`，協助我繼續進行後續的開發與運作！
```
