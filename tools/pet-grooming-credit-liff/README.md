# 寵美客戶儲值選單 LIFF（V1）

> 客戶在 LINE 內看自己的儲值餘額、瀏覽優惠方案、一鍵申請儲值。

## 🎯 解決什麼痛點

- **客戶查餘額不用問老闆** — 自己打開 LIFF 就看到目前餘額 + 最近 5 筆消費紀錄
- **方案展示視覺化** — 3 個方案卡片照圖呈現，客戶滑動就看完所有選擇
- **申請儲值半自動** — 客戶按按鈕 → 老闆 LINE 收到通知 → 老闆聯絡客戶 → 收到錢後手動記帳。比傳統「打電話問」快、比真金流系統便宜（不用串 LINE Pay / 信用卡）

## 📦 檔案

| 檔案 | 用途 |
|------|------|
| `index.html` | LIFF 前端頁面（GitHub Pages 靜態檔） |
| `Code.gs` | Apps Script 後端純 API（getMyCredit / getPlans / requestTopup / recomputeSummary） |
| `Sheets結構.md` | 「寵物店儲值帳本」檔案的 4 分頁規格 |
| `export_initial_8_to_csv.py` | 把現有 8 位客戶資料轉成 Sheets 可匯入的 CSV |
| `部署指南.md` | 第一次部署的 11 步流程 |

## 🏗️ 架構

```
客戶 LINE 點 Rich Menu 「我的儲值卡」
  ↓
LIFF 載入 index.html → liff.getProfile() 取 userId + displayName
  ↓
平行打兩支 API：
  ① GET /exec?action=getMyCredit&liffUserId=Uxxx
     → 後端反查檔案 A「客戶資料」找電話 → 撈檔案 B「交易明細」算餘額/最近5筆
  ② GET /exec?action=getPlans
     → 後端讀檔案 B「方案設定」分頁
  ↓
LIFF 渲染：餘額卡 + 3 方案卡 + 注意事項 + 最近交易表
  ↓
客戶按「我要這個方案」→ 跳 modal 確認 → POST /exec { action:"requestTopup" }
  ↓
後端推 LINE 通知老闆 + 寫「儲值申請 log」分頁
  ↓
老闆收到 LINE → 聯絡客戶確認付款 → 收到錢手動到「交易明細」append 一筆儲值
```

## 📊 資料源

- **檔案 A**（既有）：`pet-grooming-liff` 寫的「客戶資料」分頁，提供 LINE_userId↔電話 對應
- **檔案 B**（新建）：「寵物店儲值帳本」，4 個分頁
  - `客戶總覽` — 老闆 dashboard 用，半自動更新
  - `交易明細` — 資料源頭，扁平化交易記錄
  - `方案設定` — 老闆可自己改的方案表
  - `儲值申請 log` — 客戶按申請的記錄

## 🔐 安全設計

- **必填 `liffUserId`**：前端取自 `liff.getProfile()`，只有真的在 LINE 內開過 LIFF 的人拿得到。
- **客戶身份驗證靠 LINE_userId**：對到電話才查得到資料，沒登記過的客戶看不到任何餘額。
- **沒有共用 KEY**：API URL 公開無妨，撈不到 userId 對應就什麼也回不出來。
- **只回客戶自己的資料**：永遠 filter by 該客戶的電話，不會撈到別人。

## ⚠️ V1 限制（已知）

- **客戶必須先用過 `pet-grooming-liff`** 登記過資料，否則查不到自己（沒 LINE_userId↔電話 對應）
- **儲值申請≠自動付款**：申請只是通知老闆，**沒有金流串接**。實際收款還是老闆人工
- **日期是純字串**：「8/13」「11/30(114)」這種混合格式保留原樣，不強求 yyyy-mm-dd（避免 OCR / 手寫變更時格式衝突）
- **客戶總覽分頁不即時**：要老闆手動跑 `recomputeSummary()` 或加 trigger 排程（LIFF 直接從交易明細算，不依賴此分頁）
- **新增儲值/消費還是手動**：老闆要自己進「交易明細」append（之後處理 30-40 張新客戶時會做匯入腳本）

## 🚀 首次部署

看 [`部署指南.md`](./部署指南.md)（11 步、約 30-40 分鐘）

## 🐛 除錯

- **健康檢查**：`<你的 /exec 網址>?action=health` → 看到 `{"ok":true,...}`
- **方案撈不到**：Apps Script 編輯器跑 `testGetPlans()` → 看執行記錄
- **某客戶查不到餘額**：跑 `testGetMyCredit()`（先把測試 liffUserId 填進去）
- **推播失敗**：跑 `testPushLine()` 看執行記錄；檢查 ScriptProperties

## 🔄 與其他工具的關係

| 工具 | 關係 |
|------|------|
| `pet-grooming` (員工查詢頁) | **獨立** — 員工查「歷史紀錄+儲值餘額」是讀檔案 A，跟這個 LIFF 不交叉 |
| `pet-grooming-boss` (老闆儀表板) | **獨立** — 老闆儀表板看 KPI 是讀檔案 A 服務紀錄 |
| `pet-grooming-liff` (寵美登記表單) | **依賴** — 客戶必須先在這個 LIFF 登記，本工具才查得到 LINE_userId↔電話 |
| `pet-grooming-ops` (自動化維運) | **獨立** — ops 跑營收報表、健康監控；但建議把本工具的 `/exec?action=health` 加進 `HEALTH_URL` 一起監控 |
| `appointment-helper` (預約小幫手) | **獨立** |
