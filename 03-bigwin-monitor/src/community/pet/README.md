# 小遊戲精靈 🐾 寵物養成與群組 BOSS 模組

本目錄包含「小遊戲精靈：動態寵物養成、群組玩耍／玩家對戰／每日 BOSS」的核心後端規則與機器人流程。

---

## 模組清單

| 檔案 | 說明 |
|---|---|
| `rules.js` | 核心純函數業務規則：開啟基準、打碼換點（贏麻了 1,000 / 爽爆、茄子 100,000）、餘額跨日、7 日打理與死亡判定、死亡分流（重養 vs 10點復活）、固定 10% 進化、玩耍獎勵、PvP、BOSS 最大餘數法分配、Telegram initData 驗證。 |
| `store.js` | 寵物狀態持久化與不可重複流水帳本（Idempotent Ledger），保證高並發操作原子性與事件防重複。 |
| `boss-manager.js` | BOSS 戰鬥排程協調器：每日多時段定時放出、30 分鐘倒數、5 分鐘個人攻擊冷卻、傷害進度條、討伐結算與進化石派發。 |
| `pet-flow.js` | Telegram 群組交互流程：玩耍邀請/接受、PvP 對抗擂台、群組 BOSS 攻擊回調，以及管理員多時段、生命值與掉落區間設定。BOSS 常用時段、HP 和掉落區間可在私訊面板直接按鈕套用，另保留自訂輸入。 |
| `api-server.js` | 本機 HTTP 服務器，供免部署時本機快速預覽與測試 Telegram Mini App。 |

---

## 測試套件

執行所有測試（含寵物規則、API 伺服、群組機器人流程與既有小遊戲回歸）：

```powershell
node --test test/pet.test.js test/pet-api.test.js test/pet-bot-flow.test.js test/community-bot.test.js test/community-autopay.test.js test/community-safe-crack.test.js
```

全數 51 項單元與整合測試通過，無任何回歸問題。

---

## 安全與相容性保證

1. **資料隔離：** 贏麻了、爽爆、茄子三個產品資料與帳本完全隔離；每個寵物嚴格綁定唯一 AID。
2. **防重複派發：** 打碼、玩耍、進化、復活、BOSS 掉落均具備唯一 `eventId` 冪等驗證。
3. **無損回滾：**
   - 備份檔案已保留：`bot.js.bak-20261007-pethandoff`、`service.js.bak-20261007-pethandoff`、`rules.js.bak-20261007-pethandoff`。
   - 既有狼人殺、誰是臥底、海龜湯、密室逃脫、千鎖秘藏及自動派獎維持 100% 原始運作。
