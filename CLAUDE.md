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
- **寵美客戶 LIFF 表單**（`tools/pet-grooming-liff/`）— 客戶在 LINE 內自助登記寵美資訊 + 電子簽名，產 PDF 契約存 Drive，資料自動寫入客戶資料表
- **寵美客戶儲值選單 LIFF**（`tools/pet-grooming-credit-liff/`）— 客戶在 LINE 內看自己儲值餘額 + 最近 5 筆紀錄、瀏覽 3 個優惠方案、按按鈕申請儲值（自動推老闆 LINE）。資料源是新建的「寵物店儲值帳本」Sheets
- **寵美自動化維運**（`tools/pet-grooming-ops/`）— Apps Script Trigger 跑每日營收報表（Email + LINE 摘要）+ 健康監控（多 URL 各自 2 小時冷卻）+ setupGuideSheet 自動建檔案 A 「使用教學」分頁
- **使用教學主檔**（`tools/使用教學.md`）— 客戶/老闆/員工/維護工程師 四對象一站式說明，與 setupGuideSheet 內容同步

## 工作注意事項
- 學生資料一律去識別化（只用座號 + 班級代號）
- commit 訊息要寫清楚做了什麼 + 為什麼
- 收工前說「收工」讓 Claude 同步三方
