/**
 * 寵美管理 — 員工快速查詢頁 後端 API
 *
 * 部署步驟：
 *   1. 打開「檔案 A：員工服務紀錄表」Google Sheet
 *   2. 擴充功能 → Apps Script
 *   3. 把這整份貼進去（取代預設的 Code.gs 內容）
 *   4. 檔案 → 儲存（Ctrl+S）
 *   5. 右上「部署」→「新增部署」
 *      - 類型：網頁應用程式
 *      - 執行身分：我（老闆帳號）
 *      - 存取權：任何人
 *   6. 第一次部署會要求授權，按允許
 *   7. 複製「網頁應用程式 URL」
 *   8. 貼到 index.html 的 APPS_SCRIPT_URL 常數
 *
 * 更新資料後要重新部署嗎？
 *   不用。這支 doGet 每次都即時讀試算表，改試算表內容即刻生效。
 *   只有「改 Code.gs」才要重新部署。
 */

const SHEET_NAME = "客戶資料";

function doGet(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) {
      return json({ error: `找不到工作表：${SHEET_NAME}` });
    }

    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return json([]);

    const rows = values.slice(1); // 跳過表頭
    const customers = rows
      .filter((r) => r[0]) // 必須有電話
      .map(rowToCustomer);

    return json(customers);
  } catch (err) {
    return json({ error: String(err) });
  }
}

function rowToCustomer(r) {
  // 欄位對照：
  // A=0 主人電話, B=1 客戶姓名, C=2 寵物1名, D=3 寵物1品種,
  // E=4 寵物2名, F=5 寵物2品種, G=6 重要提醒, H=7 美容備註,
  // I=8 儲值金餘額, J=9 最近到店
  const pets = [];
  if (r[2]) pets.push({ name: String(r[2]).trim(), breed: String(r[3] || "").trim() });
  if (r[4]) pets.push({ name: String(r[4]).trim(), breed: String(r[5] || "").trim() });

  return {
    phone: String(r[0]).trim(),
    name: String(r[1] || "").trim(),
    pets: pets,
    alerts: String(r[6] || "")
      .split(/[;；、,，]/)
      .map((s) => s.trim())
      .filter(Boolean),
    notes: String(r[7] || "").trim(),
    balance: Number(r[8]) || 0,
    lastVisit: formatDate(r[9]),
  };
}

function formatDate(v) {
  if (!v) return "";
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).trim();
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 測試用：在 Apps Script 編輯器直接執行這支，從 Logger 看回傳值。
 * 執行前記得選「testDoGet」再按執行。
 */
function testDoGet() {
  const result = doGet();
  Logger.log(result.getContent());
}
