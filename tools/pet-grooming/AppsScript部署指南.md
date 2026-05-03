# Apps Script 部署指南 — 接上員工快速查詢頁

> 目的：把 `index.html` 從範例資料切換到即時讀 Google Sheets。
> 前置：已依 `Sheets建置指南.md` 建好檔案 A，`客戶資料` 工作表至少有 3-5 筆測試資料。
> 預計時間：10 分鐘（第一次做）。

---

## 🎯 總流程

```
老闆帳號打開檔案 A
  → 擴充功能 / Apps Script
    → 貼上 Code.gs
      → 部署為網頁應用程式
        → 拿到 /exec 網址
          → 貼到 index.html 的 APPS_SCRIPT_URL
            → 完成 ✅
```

---

## 步驟 1：打開檔案 A 的 Apps Script 編輯器

1. **用老闆帳號**登入 Google
2. 打開【檔案 A：員工服務紀錄表】
3. 頂部選單：**擴充功能** → **Apps Script**
4. 新分頁會開啟 Apps Script 編輯器，左側可看到 `Code.gs`

> ⚠️ 必須在**檔案 A 裡**點「擴充功能→Apps Script」，不是從 `script.google.com` 另開新專案。這樣 Apps Script 才會綁定到正確的試算表（`SpreadsheetApp.getActiveSpreadsheet()` 才指向檔案 A）。

## 步驟 2：把 Code.gs 整份貼進去

1. 打開 `tools/pet-grooming/Code.gs`（你這個 repo 內）
2. 全選複製
3. 回到 Apps Script 編輯器，把預設的 `function myFunction() {}` 整段刪掉
4. 貼上 Code.gs 全部內容
5. 檔案名稱照舊叫 `Code.gs`
6. `Ctrl+S` 存檔（Mac 是 `Cmd+S`）
7. 左上專案名改成例如 `寵美查詢 API`（方便日後找）

## 步驟 3：先測試一次確定沒錯

1. 編輯器上方函式下拉選單 → 選 **`selfCheck`**（一支函式同時驗 3 項依賴）
2. 按「執行」
3. **第一次會彈出授權提示**：
   - 按「檢閱權限」
   - 選老闆 Google 帳號
   - 看到「Google 尚未驗證此應用程式」→ 按「進階」→「前往 [你的專案名]（不安全）」
   - 按「允許」
   > 🤔 為什麼顯示「不安全」？因為這個 Apps Script 是你自己寫的，沒送 Google 審查。只要是你自己的帳號、自己寫的腳本，安全沒問題。
4. 執行完畢後下方「執行記錄」應該看到 4 行報告，3 項全綠勾：
   ```
   === selfCheck (pet-grooming) ===
   ✓ 容器檔案 A（客戶資料）：N 列
   ✓ 檔案 B（交易明細）：M 列
   ✓ LINE API 連通性：HTTP 401（網路通）
   ```
5. 哪一項打 ✗ 就照細節修：
   - **容器檔案 A** ✗ `找不到分頁：客戶資料` → 工作表名稱不對，回檔案 A 改名或改 Code.gs 第一行 `SHEET_NAME`
   - **檔案 B** ✗ `You do not have permission...` → 老闆帳號沒被加進「寵物店儲值帳本」共用清單，或老闆娘把帳號移除了 → 補回共用清單再跑一次
   - **LINE API 連通性** ✗ `HTTP 5xx` 或網路錯 → Google 端問題，重試
6. 全綠後可以再選 `testReadCustomers` 看 client 拿到的客戶 JSON 長相

## 步驟 4：部署為網頁應用程式

1. 右上「**部署**」→「**新增部署**」
2. 齒輪圖示 → 選「**網頁應用程式**」
3. 設定：
   - 說明：`v1`（之後改 Code.gs 要新版本時可以寫 `v2`）
   - 執行身分：**我（老闆帳號）**
   - 存取權：**任何人**（⚠️ 不是「任何擁有 Google 帳戶的使用者」）
4. 按「部署」
5. 複製「**網頁應用程式 URL**」— 長這樣：
   ```
   https://script.google.com/macros/s/AKfycbx...../exec
   ```
6. 按「完成」

> 🔒 「存取權：任何人」會不會不安全？
> - 拿到 URL 的人才能呼叫；URL 是亂碼，貼給別人才會外流
> - 只回傳客戶資料（非公開但也非極機密），建議搭配後續 V3 加存取密碼參數
> - 目前版本：URL 當密碼等級，**別 commit 到 repo、別貼到公開網頁原始碼之外的地方**

## 步驟 5：把 URL 貼進 index.html

打開 `tools/pet-grooming/index.html`，找到這段（約第 89 行）：

```js
const APPS_SCRIPT_URL = "";
```

改成：

```js
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbx...../exec";
```

存檔。重整頁面（或按右上「重新整理」）。

## 步驟 6：驗證

頁面打開後：
- 搜尋列右側應顯示 **🟢 雲端資料 · 更新於 HH:MM**
- 「共 N 筆客戶資料」的 N 應該等於檔案 A 客戶資料表的列數
- 搜尋你剛在試算表填的資料，應該搜得到
- 如果看到 **🔴 讀取失敗** 或 **🟡 範例資料**，照下方疑難排解

---

## 🛠️ 疑難排解

### 看到「🟡 範例資料」
→ `APPS_SCRIPT_URL` 還是空字串。確認你把 URL 貼進去、存檔、重整頁面。

### 看到「🔴 讀取失敗」原因：`HTTP 302 / 401 / 403`
→ 部署時「存取權」沒設成「**任何人**」。重新部署一次，選「管理部署」→ 編輯 → 修正「存取權」。

### 看到「🔴 讀取失敗」原因：`找不到工作表：客戶資料`
→ 檔案 A 的工作表名稱不叫「客戶資料」。改名或改 `Code.gs` 的 `SHEET_NAME`。

### 資料都正常但日期顯示怪怪的（例：`Tue Apr 15 2026 00:00:00 GMT+0800`）
→ 檔案 A 的「最近到店」欄是文字不是日期。選整欄 → 格式 → 數字 → 日期。

### 員工改了試算表資料，查詢頁看不到更新
→ 按頁面右上「🔄 重新整理」。Apps Script 沒有推播機制，所以頁面要主動重抓。

### 改了 Code.gs 之後，網頁抓到的是舊版
→ 改 Code.gs **必須重新部署新版本**：部署 → 管理部署 → 齒輪 → 編輯 → 版本改「新版本」 → 部署。**URL 不會變**，不用改 index.html。

### LIFF 全店爆「Failed to fetch」（線上事故）
→ 編輯器選 **`selfCheck`** → 執行 → 看執行記錄哪一項打 ✗，30 秒定位斷點：
- 檔案 A ✗ → 老闆帳號沒了試算表權限（罕見，幾乎不會發生）
- 檔案 B ✗ `PermissionDenied` → 共用清單被改（5/3 案例：老闆娘調共用誤刪工程師帳號）→ 補回共用、編輯器跑 `authorizeServices` 觸發新授權
- LINE API ✗ → Google 對外網路問題，重試或等
- 全綠但 LIFF 還是炸 → 看 doGet 執行記錄錯誤訊息（Apps Script → 執行記錄 → 失敗那筆點開）

---

## 📈 後續可以加的功能（V3+）

- **加存取密碼**：Code.gs 檢查 `e.parameter.key === "XXX"`，index.html 加 query string
- **員工填服務紀錄**：加一個前端表單、Apps Script 加 `doPost()` 寫入「服務紀錄」工作表
- **自動產生 LINE 訊息**：結帳小幫手那個工具
- **客戶端 LIFF 頁**：給客戶自己查餘額的 LINE 內嵌頁
