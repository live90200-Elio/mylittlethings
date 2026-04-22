# Mylittlethings — 我的班級工具總專案

## 對話開始時請先讀
進度與最近更動都在 Obsidian：`secondbrain/Mylittlethings/工作筆記.md`

## 工作模式
- **加新工具**：對 Claude 說「我想做一個 XXX 工具」→ Claude 會建 `tools/<工具名>/` 子資料夾、引導我跟著 EP10 影片做
- **結束工作**：對 Claude 說「**收工**」→ 自動 commit + push + 更新 Obsidian 工作筆記
- **接續工作**：對 Claude 說「讀工作筆記、告訴我上次做到哪」

## 工作桌 + 三個家
- 📋 GDrive 工作桌：`C:\Users\ZING\我的雲端硬碟\Mylittlethings\`（自動跨電腦同步）
- 🐙 GitHub repo：`live90200-Elio/mylittlethings`（公開，網頁的家）
- 📘 Obsidian 駕駛艙：`secondbrain/Mylittlethings/工作筆記.md`（想法的家）
- 🔥 Firebase 專案：`my-teaching-tools`（或你建的，資料的家）

## 工具清單
- **寵美管理：員工快速查詢頁**（`tools/pet-grooming/`）— 店內平板用，輸入電話查客戶歷史與儲值餘額
- **寵美管理：老闆私藏儀表板**（`tools/pet-grooming-boss/`）— BOSS_KEY 密碼登入，KPI + 月對月成長 + CSV 匯出 + PWA
- **預約小幫手**（`tools/appointment-helper/`）— 抓 Google 日曆明日預約，產員工清單 + 客戶提醒草稿，一鍵複製

## 工作注意事項
- 學生資料一律去識別化（只用座號 + 班級代號）
- commit 訊息要寫清楚做了什麼 + 為什麼
- 收工前說「收工」讓 Claude 同步三方
