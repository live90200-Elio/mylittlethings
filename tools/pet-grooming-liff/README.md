# 寵美客戶 LIFF 表單（V1）

> 客戶在 LINE 內自助填寫寵美資訊 + 簽名，自動寫入 Google Sheets 並產 PDF 契約存 Drive。

## 🎯 解決什麼痛點

- **老闆不用再手動建客戶檔** — 客戶自己填，送出就寫進檔案 A 的「客戶資料」工作表，員工查詢頁立刻看得到
- **契約留下合法紀錄** — 每筆送出會產 PDF（內含簽名 + 時間戳 + SHA-256 哈希）存 Drive，未來有爭議可驗證
- **老闆只要傳連結給客戶** — 支援 LINE Rich Menu 按鈕一鍵開啟

## 📦 檔案

| 檔案 | 用途 |
|------|------|
| `index.html` | LIFF 前端表單（由 Apps Script `doGet()` 伺服，用 `<?= ?>` 模板注入 KEY/ID） |
| `Code.gs` | Apps Script 後端（`doGet` 回傳 HTML + `doPost` 寫 Sheets + 產 PDF + 存 Drive） |
| `部署指南.md` | 第一次部署的完整步驟 |

> 🏗️ **架構**：HTML + 後端都由 Apps Script 伺服，不走 GitHub Pages。所以密碼類常數只存 Apps Script 線上版，public repo 看不到真值。

## 🔗 資料流

```
客戶 LINE 點 Rich Menu「寵美資訊」
  ↓
LIFF 自動帶入客戶 LINE userId + displayName
  ↓
客戶填表 + Canvas 簽名 + 勾選同意注意事項
  ↓ POST（text/plain 避開 CORS）
Apps Script Code.gs:
  ① 驗證 KEY + 必填
  ② 算 SHA-256 哈希（防竄改）
  ③ Upsert「客戶資料」工作表（電話 key）
  ④ 產 PDF（HTML → PDF）存 Drive 指定資料夾
  ⑤ 寫「契約紀錄」工作表
  ⑥ 回傳 PDF 連結
  ↓
LIFF 顯示「已送出」+ PDF 連結
```

## 🔐 安全設計

- **KEY 驗證**：前後端共用 `LIFF_KEY`，擋直接打 API 的人
- **KEY 不進 public repo**：`Code.gs` 裡 `LIFF_KEY` 在 repo 是佔位符，真實密碼只存 Apps Script 線上版；`index.html` 用 `<?= LIFF_KEY ?>` 模板注入，repo 裡也看不到真值
- **資料完整性**：每筆契約算 SHA-256 存到 Sheets，日後可驗 Drive PDF 是否被改
- **LINE userId**：僅供紀錄追溯，不作為身份驗證依據

## ⚠️ V1 限制（已知）

- **沒有美容師簽名** — 契約 PDF 只有客戶簽名，美容師簽名欄留白（現場補紙本或 V2 補做）
- **沒有 LINE Access Token 後端驗證** — 僅用 KEY，V2 考慮加 `liff.getAccessToken()` + 後端驗 token
- **PDF 字型依賴 Apps Script 內建** — 中文若出問題需調整 font-family
- **不支援修改已送出的契約** — 一律 append-only，改需重新送一筆（哈希會變）

## 🚀 首次部署

看 [`部署指南.md`](./部署指南.md)

## 🐛 除錯

- **前端問題**：LINE 內打開 → 搖動手機會打開 LIFF Debug；或用電腦瀏覽器開 Apps Script `.../exec` 網址進「開發模式」（非 LIFF 環境 fallback 到純 Web 表單，不會真送資料）
- **後端問題**：Apps Script 編輯器 → 執行 `testDoPost()` → 看「執行記錄」
- **資料問題**：檢查 Sheets「契約紀錄」有沒有新列；Drive 資料夾有沒有新 PDF
- **本地預覽注意**：直接用 Live Server 打開 `index.html` 會看到 `<?= LIFF_ID ?>` 原始文字（預期行為，模板要 Apps Script 處理才會渲染）
