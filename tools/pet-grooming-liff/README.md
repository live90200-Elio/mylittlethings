# 寵美客戶 LIFF 表單（V1）

> 客戶在 LINE 內自助填寫寵美資訊 + 簽名，自動寫入 Google Sheets 並產 PDF 契約存 Drive。

## 🎯 解決什麼痛點

- **老闆不用再手動建客戶檔** — 客戶自己填，送出就寫進檔案 A 的「客戶資料」工作表，員工查詢頁立刻看得到
- **契約留下合法紀錄** — 每筆送出會產 PDF（內含簽名 + 時間戳 + SHA-256 哈希）存 Drive，未來有爭議可驗證
- **老闆只要傳連結給客戶** — 支援 LINE Rich Menu 按鈕一鍵開啟

## 📦 檔案

| 檔案 | 用途 |
|------|------|
| `index.html` | LIFF 前端表單（靜態 HTML，LIFF_ID + API URL 直接寫死在檔案裡） |
| `Code.gs` | Apps Script 後端（只當 API：`doPost` 寫 Sheets + 產 PDF + 存 Drive） |
| `部署指南.md` | 第一次部署的完整步驟 |

> 🏗️ **架構**：前端 `index.html` 靜態檔（可放 GitHub Pages 或任何靜態主機），後端 Apps Script 只處理 POST API。完全沒有共用密碼 KEY，也不用模板注入。

## 🔗 資料流

```
客戶 LINE 點 Rich Menu「寵美資訊」
  ↓
LIFF 載入 index.html → 初始化 LINE SDK 取得 userId + displayName
  ↓
客戶填表 + Canvas 簽名 + 勾選同意注意事項
  ↓ POST（text/plain 避開 CORS）
Apps Script Code.gs doPost:
  ① 驗證必填（含 liffUserId，沒登入 LINE 送不進來）
  ② 算 SHA-256 哈希（防竄改）
  ③ Upsert「客戶資料」工作表（電話 key）
  ④ 產 PDF（HTML → PDF）存 Drive 指定資料夾
  ⑤ 寫「契約紀錄」工作表
  ⑥ 回傳 PDF 連結
  ↓
LIFF 顯示「已送出」+ PDF 連結
```

## 🔐 安全設計

- **必填 `liffUserId`**：前端取自 `liff.getProfile()`，只有真的在 LINE 內開啟過 LIFF 的使用者才拿得到。直接打 API 沒帶 userId 會被擋。
- **`LIFF_ID` 本來就是公開資訊**：在 LINE Developers Console 就能查到，不是機密。
- **Apps Script `/exec` URL 可公開**：Web App 寫死「所有人」可打，但 API 內容只回 JSON 狀態，拿到 URL 也打不壞什麼。
- **資料完整性**：每筆契約算 SHA-256 存到 Sheets，日後可驗 Drive PDF 是否被改。
- **LINE userId**：僅供紀錄追溯，不作為身份驗證依據。

## ⚠️ V1 限制（已知）

- **沒有美容師簽名** — 契約 PDF 只有客戶簽名，美容師簽名欄留白（現場補紙本或 V2 補做）
- **沒有 LINE Access Token 後端驗證** — 只靠前端帶 `liffUserId`，不擋惡意偽造。V2 可加 `liff.getAccessToken()` + 後端驗 token
- **PDF 字型依賴 Apps Script 內建** — 中文若出問題需調整 font-family
- **不支援修改已送出的契約** — 一律 append-only，改需重新送一筆（哈希會變）

## 🚀 首次部署

看 [`部署指南.md`](./部署指南.md)

## 🐛 除錯

- **前端問題**：LINE 內打開 → 搖動手機會打開 LIFF Debug；或用電腦瀏覽器直接開 `index.html`（非 LIFF 環境，`liff.init` 會報錯但表單 UI 可以看）
- **後端問題**：Apps Script 編輯器 → 執行 `testDoPost()` → 看「執行記錄」
- **資料問題**：檢查 Sheets「契約紀錄」有沒有新列；Drive 資料夾有沒有新 PDF
- **健康檢查**：瀏覽器打 `<你的 /exec 網址>?health=1` → 看到 `{"ok":true,...}` 代表後端活著
