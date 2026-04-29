# Google Sheets 建置指南 — 寵美管理

> 對應工具：`tools/pet-grooming/index.html`（員工快速查詢頁）
> 設計目標：員工能記帳、查客戶；看不到月總營業額。

---

## 帳號策略：兩個帳號、三份權限

| 角色 | 建議 Google 帳號 | 能看到的檔案 |
|---|---|---|
| **老闆**（你） | 你的個人 Gmail（例：`boss@gmail.com`） | 檔案 A ✅ + 檔案 B ✅ |
| **員工共用**（店內平板、員工電話上用） | 新開一個專用帳號（例：`shop-tablet@gmail.com`） | 檔案 A ✅（只有編輯權）／ 檔案 B ❌ |

### 兩個檔案誰建？

| 檔案 | 建在哪個帳號 | 誰能編輯 |
|---|---|---|
| **檔案 A：員工服務紀錄表** | **老闆帳號建**（你擁有所有權） | 老闆全權 + 員工帳號編輯權 |
| **檔案 B：老闆私藏報表** | **老闆帳號建**（完全不分享） | 只有老闆 |

> 🔥 **關鍵：兩份都老闆建**。如果 A 建在員工帳號，員工離職或帳號被盜 = 你的客戶資料可能被刪。老闆建 = 你永遠有所有權 + 可隨時撤回員工權限。

### 分享步驟（A 檔案建完後）
1. 在老闆帳號開檔案 A → 右上「共用」
2. 加入員工共用帳號的信箱 → 權限選「編輯者」
3. 不勾「通知」、不勾「允許他人再次分享」
4. 完成

### 店內平板怎麼設？
1. 平板上只登入員工共用帳號（**不要**登入老闆帳號）
2. 把員工快速查詢頁 + 檔案 A 都加到書籤
3. 老闆帳號完全不碰平板

---

## 檔案 A 結構（員工可編輯）

### 工作表 1：`客戶資料`（員工快速查詢頁就是讀這張）

| 欄 | 標題 | 說明 | 範例 |
|---|---|---|---|
| A | 主人電話 | **主鍵，不可重複** | 0912345678 |
| B | 客戶姓名 | 主人名字 | 林小姐 |
| C | 寵物1名 | | 小白 |
| D | 寵物1品種 | | 馬爾濟斯 |
| E | 寵物2名 | 選填 | |
| F | 寵物2品種 | 選填 | |
| G | 重要提醒 | 多個用分號`；`分隔 | 兇；心臟病 |
| H | 美容備註 | 長文字 | 耳朵易發炎；怕剪刀聲 |
| I | 儲值金餘額 | 數字 | 3200 |
| J | 最近到店 | 日期 | 2026-04-15 |

> 建議把 A 欄設「資料驗證 → 僅允許數字 + 唯一」。

### 工作表 2：`服務紀錄`（每筆交易一列）

| 欄 | 標題 | 說明 | 範例 |
|---|---|---|---|
| A | 日期 | | 2026-04-21 |
| B | 主人電話 | 對應客戶資料表 | 0912345678 |
| C | 寵物名 | | 小白 |
| D | 服務項目 | 洗/剪/全套 | 全套 |
| E | 金額 | 數字 | 800 |
| F | 付款方式 | 現金/轉帳/儲值扣抵 | 儲值扣抵 |
| G | 負責美容師 | | Amy |
| H | 備註 | 選填 | 加耳道清潔 |

> ⚠️ **E 欄「金額」底下絕對不要放 `=SUM(E:E)`**。SOP 要求月總營收隱藏，員工表不做加總。

### 工作表 3：`儲值紀錄`（選配但推薦）

| 欄 | 標題 | 說明 | 範例 |
|---|---|---|---|
| A | 日期 | | 2026-04-21 |
| B | 主人電話 | | 0912345678 |
| C | 類型 | 儲值/扣抵/退款 | 扣抵 |
| D | 金額 | 正數；扣抵用負數易混淆，建議一律正數搭配 C 欄判斷 | 800 |
| E | 扣抵後餘額 | 人工填或用公式 | 2400 |
| F | 備註 | | 4/21 全套 |

> 用途：客戶質疑餘額時可對帳；月底核對檔案 B 的儲值金總庫存。

---

## 檔案 B 結構（老闆私藏）

### 工作表 1：`原始資料匯入`

```
A1 儲存格：=IMPORTRANGE("檔案A的網址", "服務紀錄!A:H")
```

> 第一次用會彈「允許存取」→ 按一次終身生效。

### 工作表 2：`月總營收`

```
B2：=SUMIFS(原始資料匯入!E:E, 原始資料匯入!A:A, ">="&DATE(2026,4,1), 原始資料匯入!A:A, "<"&DATE(2026,5,1))
```

### 工作表 3：`美容師拆帳`

用樞紐分析表（Pivot Table）：
- 列：負責美容師
- 欄：月份
- 值：金額加總

### 工作表 4：`利潤分析`（選配）

自己另建「耗材支出」工作表記錄進貨，然後：
```
利潤 = 月總營收 - 耗材支出 - 人事 - 租金
```

---

## 員工快速查詢頁怎麼接這張表？

目前 `index.html` 用的是寫死的 `CUSTOMERS` 陣列（範例資料）。真正接 Google Sheets 需要兩步：

1. **在老闆帳號的檔案 A 建一個 Google Apps Script**：
   - `擴充功能 → Apps Script`
   - 寫一個 `doGet()` 函式把`客戶資料`工作表轉成 JSON 回傳
   - 部署為「網頁應用程式」→ 執行身分：我、存取權：任何人
   - 拿到一個 `https://script.google.com/macros/s/xxx/exec` 網址

2. **把 `index.html` 的 `CUSTOMERS` 換成 `fetch(那個網址)`**：
   ```js
   const res = await fetch("https://script.google.com/macros/s/xxx/exec");
   const CUSTOMERS = await res.json();
   ```

> 這一步等你先把 Sheets 建好、填十來筆真實資料測試過再做。之後跟我說「接 Apps Script」我會繼續。

---

## 建置 checklist（照順序做）

- [ ] 開一個員工共用 Google 帳號（`shop-tablet@gmail.com` 類）
- [ ] 在老闆帳號建【檔案 A：員工服務紀錄表】
- [ ] 建三張工作表 + 填表頭（上面欄位）
- [ ] 填 3-5 筆真實客戶（從紙本搬，用手機號當 ID）
- [ ] 分享檔案 A 給員工共用帳號，權限=編輯
- [ ] 在老闆帳號建【檔案 B：老闆私藏報表】
- [ ] 工作表 1 寫 IMPORTRANGE 抓檔案 A
- [ ] 工作表 2 寫 SUMIFS 算月總營收
- [ ] 店內平板登入員工共用帳號、登出老闆帳號
- [ ] 回來跟 Claude 說「接 Apps Script」把查詢頁接上實際資料

---

## 2026-04-29 更新紀錄：LINE LIFF 客戶查詢上線流程

本次調整目標：把客戶查詢頁改成可放在 LINE LIFF 選單中使用，並確保 GitHub Pages 前端公開時不會直接暴露客戶資料。

### 目前檔案分工

- `customer.html`
  - GitHub Pages 上線使用的 LIFF 前端頁面。
  - Endpoint URL 對應：`https://live90200-elio.github.io/line-clock/customer.html`
  - LIFF URL 對應：`https://liff.line.me/2009523185-49rQ33n5`

- `customer-cute.html`
  - UX/UI 優化版本。
  - 檢查通過後，可把內容複製到 GitHub 上的 `customer.html` 覆蓋更新。
  - 只改前端畫面，不改後端安全邏輯。

- `Code.gs`
  - Google Apps Script 後端 API。
  - 負責讀取 Google Sheets、驗證 LINE access token、檢查白名單 userId。
  - 必須部署成 Web App，前端才拿得到資料。

### LIFF 設定

- LIFF ID：`2009523185-49rQ33n5`
- LIFF app name：`客戶查詢`
- Size：`Full`
- Endpoint URL：`https://live90200-elio.github.io/line-clock/customer.html`
- LINE 官方帳號選單連結：`https://liff.line.me/2009523185-49rQ33n5`
- 選單動作標籤：`客戶查詢`

### 安全流程

GitHub Pages 上的 `customer.html` 是公開檔案，任何人都可能開啟網址或看見前端程式碼。安全性不能放在前端判斷，必須由 Apps Script 後端控管。

目前安全流程如下：

1. 使用者從 LINE 選單開啟 LIFF。
2. `customer.html` 執行 `liff.init()`。
3. 若尚未登入 LINE，前端執行 `liff.login()`。
4. 登入後，前端用 `liff.getAccessToken()` 取得 LINE access token。
5. 前端呼叫 Apps Script Web App，傳送 `action=customers` 與 `token=<LINE access token>`。
6. Apps Script 用 `UrlFetchApp.fetch("https://api.line.me/v2/profile")` 向 LINE 官方驗證 token。
7. LINE 回傳真正的 `userId`。
8. Apps Script 比對 `ALLOWED_LINE_USER_IDS` 白名單。
9. 只有白名單內的 LINE userId 才回傳客戶資料。
10. 未授權帳號回傳：`此帳號未授權，請聯絡店長`。

重點：不要改回只傳 `?userId=xxx` 的版本，因為 userId 可以被偽造。必須用 LINE access token 由後端向 LINE 官方驗證。

### 目前允許查看資料的 LINE userId

白名單位置：`Code.gs`

```js
const ALLOWED_LINE_USER_IDS = {
  "Uc91d607de27558c937af89be42699678": "員工A",
  "U5098240716740dd49287db197da9c878": "員工B",
  "U61199309b9ff3f86b4872f1aeb147418": "員工C",
  "Udb797fdc8b926bff6f972be748450ecb": "員工D"
};
```

新增或移除可查詢人員時，只修改這個白名單，然後重新部署 Apps Script 新版本。

### Google Sheets 欄位

Apps Script 讀取分頁名稱：`客戶資料`

| 欄位 | 內容 |
|---|---|
| A | 電話 |
| B | 姓名 |
| C | 寵物1名 |
| D | 寵物1品種 |
| E | 寵物2 |
| F | 寵物2品種 |
| G | 重要提醒 |
| H | 美容備註 |
| I | 儲值金餘額 |
| J | 最近到店 |
| K | 建立時間 |
| L | 來源 |
| M | 本次服務 |
| N | 本次金額 |
| O | LINE_userId |

### Apps Script 首次授權流程

如果手機畫面出現類似：

```text
你沒有呼叫「UrlFetchApp.fetch」的權限
```

代表 Apps Script 尚未授權呼叫外部 API。處理方式：

1. 到 Apps Script 編輯器。
2. 確認已貼上新版 `Code.gs`。
3. 儲存。
4. 上方函式選單選 `authorizeServices`。
5. 按「執行」。
6. 依 Google 提示完成授權。
7. 授權後重新部署 Web App 新版本。

`authorizeServices()` 只需要在首次授權或權限異動時手動執行。

### Apps Script 部署設定

部署 Web App 時建議設定：

- 執行身分：`我`
- 存取權：`任何人`
- 每次修改 `Code.gs` 後：儲存，部署，管理部署作業，編輯目前部署，版本選「新增版本」，再部署。

說明：Web App 設為「任何人」是為了讓 LIFF 前端可以呼叫 API；真正資料權限由後端的 LINE token 驗證與白名單控管。

### UX/UI 更新流程

只改畫面時，不一定要改 Apps Script。

更新前端 UI 的流程：

1. 在本地修改或檢查 `customer-cute.html`。
2. 確認以下項目仍存在：
   - `LIFF_ID = "2009523185-49rQ33n5"`
   - `APPS_SCRIPT_URL` 指向目前 Apps Script `/exec`
   - `liff.init()`
   - `liff.isLoggedIn()`
   - `liff.getAccessToken()`
   - 呼叫 Apps Script 時傳 `action=customers` 和 `token`
3. 確認前端沒有寫入客戶假資料、白名單 userId 或繞過登入的邏輯。
4. 把 `customer-cute.html` 的完整內容複製到 GitHub repo 的 `customer.html`。
5. 等 GitHub Pages 更新後，從 LINE 選單重新開啟測試。

### 今日確認結果

- `customer-cute.html` 的 JavaScript 語法檢查通過。
- `customer-cute.html` 保留 LIFF 登入與 token 傳後端流程。
- 前端沒有包含客戶資料。
- 前端沒有包含白名單 userId。
- 白名單與客戶資料存取仍由 Apps Script 後端負責。
- 若已確認新版 `Code.gs` 部署成功，則可以只把 `customer-cute.html` 覆蓋到 GitHub 的 `customer.html` 來更新 UI。