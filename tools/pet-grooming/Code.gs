/**
 * LINE LIFF 員工客戶查詢 API
 *
 * 資料源：
 *   - 檔案 A「客戶資料」分頁（容器綁定）：基本資訊 / 寵物 / 提醒 / 美容備註 / 最近到店 / 服務紀錄
 *   - 檔案 B「寵物店儲值帳本」「交易明細」分頁：算每位客戶目前餘額（取最後一筆有餘額的列）
 *   - 檔案 B「包月客戶」分頁：算每位客戶包月狀態（取該客戶最新一筆，看已用/剩餘/到期日）
 *
 * 餘額**只看檔案 B**，檔案 A 已不再有「儲值金餘額」欄位（4/30 起棄用）。
 *
 * 客戶資料 schema（檔案 A，14 欄；header-based 解析，欄序動了也不會壞）：
 * 電話 / 姓名 / 寵物1名 / 寵物1品種 / 寵物2名 / 寵物2品種 /
 * 重要提醒 / 美容備註 / 最近到店 / 建立時間 / 來源 / 本次服務 / 本次金額 / LINE_userId
 *
 * 包月分頁 schema（檔案 B，12 欄；位置解析，header 不能亂改）：
 * A 日期 | B 電話 | C 客戶姓名 | D 寵物名 | E 服務 | F 本次狀態 |
 * G 金額 | H 已用次數 | I 剩餘 | J 到期日 | K 簽名 | L 備註
 */

const SHEET_NAME = "客戶資料";

// 檔案 B「寵物店儲值帳本」（跟 credit-liff Code.gs 同一個 URL）
const FILE_B_URL = "https://docs.google.com/spreadsheets/d/1yK6KNkOTJyaDiZMd5RxoZIDvOngQf6zgslN-H5Q-KaA/edit";
const SHEET_LEDGER = "交易明細";
const SHEET_MONTHLY = "包月客戶";

const ALLOWED_LINE_USER_IDS = {
  "Uc91d607de27558c937af89be42699678": "員工A",
  "U5098240716740dd49287db197da9c878": "員工B",
  "U61199309b9ff3f86b4872f1aeb147418": "員工C",
  "Udb797fdc8b926bff6f972be748450ecb": "員工D"
};

function doGet(e) {
  try {
    const action = getParam_(e, "action") || "customers";

    if (action === "health") {
      return json_({ ok: true, message: "ok", updatedAt: new Date().toISOString() });
    }

    if (action !== "customers") {
      return json_({ ok: false, message: "不支援的 action" });
    }

    const token = getParam_(e, "token");
    const profile = verifyLineAccessToken_(token);

    if (!profile.userId || !ALLOWED_LINE_USER_IDS[profile.userId]) {
      return json_({
        ok: false,
        code: "FORBIDDEN",
        message: "此帳號未授權，請聯絡店長"
      });
    }

    return json_({
      ok: true,
      viewer: {
        userId: profile.userId,
        name: ALLOWED_LINE_USER_IDS[profile.userId],
        displayName: profile.displayName || ""
      },
      customers: readCustomers_(),
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    return json_({
      ok: false,
      message: err && err.message ? err.message : String(err)
    });
  }
}

function readCustomers_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    throw new Error("找不到分頁：" + SHEET_NAME);
  }

  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const headers = values[0].map((h) => cleanText_(h));
  const idx = buildHeaderIndex_(headers);
  const phoneCol = idx["電話"] != null ? idx["電話"] : 0;
  const balanceMap = loadBalanceMap_();
  const monthlyMap = loadMonthlyMap_();

  return values
    .slice(1)
    .filter((row) => cleanText_(row[phoneCol]))
    .map((row) => rowToCustomer_(row, idx, balanceMap, monthlyMap));
}

function buildHeaderIndex_(headers) {
  const map = {};
  headers.forEach((h, i) => {
    if (h) map[h] = i;
  });
  return map;
}

function getCell_(row, idx, header) {
  const i = idx[header];
  return i == null ? "" : row[i];
}

function rowToCustomer_(row, idx, balanceMap, monthlyMap) {
  const phone = cleanText_(getCell_(row, idx, "電話"));
  const pets = [];
  addPet_(pets, getCell_(row, idx, "寵物1名"), getCell_(row, idx, "寵物1品種"));
  // 兼容兩種 header：「寵物2名」（檔案 A 4/30 後實際）或「寵物2」（舊版/簡寫）
  const pet2Name = getCell_(row, idx, "寵物2名") || getCell_(row, idx, "寵物2");
  addPet_(pets, pet2Name, getCell_(row, idx, "寵物2品種"));

  const phoneKey = normalizePhone_(phone);
  const balance = phoneKey && balanceMap[phoneKey] != null ? balanceMap[phoneKey] : 0;
  const monthly = phoneKey && monthlyMap && monthlyMap[phoneKey] ? monthlyMap[phoneKey] : null;

  return {
    phone: phone,
    name: cleanText_(getCell_(row, idx, "姓名")),
    pets: pets,
    alerts: splitAlerts_(getCell_(row, idx, "重要提醒")),
    notes: cleanText_(getCell_(row, idx, "美容備註")),
    balance: balance,
    monthly: monthly,
    lastVisit: formatDate_(getCell_(row, idx, "最近到店")),
    createdAt: formatDateTime_(getCell_(row, idx, "建立時間")),
    source: cleanText_(getCell_(row, idx, "來源")),
    currentService: cleanText_(getCell_(row, idx, "本次服務")),
    currentAmount: toNumber_(getCell_(row, idx, "本次金額")),
    lineUserId: cleanText_(getCell_(row, idx, "LINE_userId"))
  };
}

// 從檔案 B「交易明細」算每位客戶目前餘額（取最後一筆有餘額非空的當目前餘額）
function loadBalanceMap_() {
  try {
    const sheet = SpreadsheetApp.openByUrl(FILE_B_URL).getSheetByName(SHEET_LEDGER);
    if (!sheet) return {};
    const data = sheet.getDataRange().getValues();
    // 交易明細欄序：A 電話 | B 姓名 | C 日期 | D 儲值金額 | E 消費項目 | F 消費金額 | G 餘額 | H 簽名 | I 備註
    const map = {};
    for (let i = 1; i < data.length; i++) {
      const phoneKey = normalizePhone_(data[i][0]);
      if (!phoneKey) continue;
      const bal = parseAmount_(data[i][6]);
      if (bal !== null) map[phoneKey] = bal;
    }
    return map;
  } catch (err) {
    Logger.log("loadBalanceMap_ failed: " + err);
    return {};
  }
}

// 從檔案 B「包月客戶」算每位客戶包月狀態（取該客戶最新一筆當當前狀態）
// 回傳: { phoneKey: { used, remaining, daysLeft, expireDate, isActive, isExpired, isUsedUp, petName } }
function loadMonthlyMap_() {
  try {
    const sheet = SpreadsheetApp.openByUrl(FILE_B_URL).getSheetByName(SHEET_MONTHLY);
    if (!sheet) return {};
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return {};

    // 包月分頁欄序：A 日期 | B 電話 | C 客戶姓名 | D 寵物名 | E 服務 | F 本次狀態 | G 金額 | H 已用次數 | I 剩餘 | J 到期日 | K 簽名 | L 備註
    // 紙本可能不依日期順序貼進來，所以掃全表找每位客戶最新一筆
    const latest = {};
    for (let i = 1; i < data.length; i++) {
      const phoneKey = normalizePhone_(data[i][1]);
      if (!phoneKey) continue;
      const date = parseDate_(data[i][0]);
      if (!date) continue;
      if (!latest[phoneKey] || date.getTime() > latest[phoneKey].date.getTime()) {
        latest[phoneKey] = { date: date, row: data[i] };
      }
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const msPerDay = 24 * 60 * 60 * 1000;
    const tz = Session.getScriptTimeZone();

    const map = {};
    for (const phoneKey in latest) {
      const row = latest[phoneKey].row;
      const used = Number(row[7]);
      const remaining = Number(row[8]);
      const expireDate = parseDate_(row[9]);
      const petName = cleanText_(row[3]);

      // 老闆娘漏填關鍵欄位 → 不顯示包月狀態（避免誤導）
      if (!expireDate || !Number.isFinite(used) || !Number.isFinite(remaining)) continue;

      const expireMidnight = new Date(expireDate);
      expireMidnight.setHours(0, 0, 0, 0);
      const daysLeft = Math.round((expireMidnight.getTime() - today.getTime()) / msPerDay);
      const isExpired = daysLeft < 0;
      const isUsedUp = used >= 5 || remaining <= 0;
      const isActive = !isExpired && !isUsedUp;

      map[phoneKey] = {
        used: used,
        remaining: remaining,
        daysLeft: daysLeft,
        expireDate: Utilities.formatDate(expireMidnight, tz, "yyyy-MM-dd"),
        isActive: isActive,
        isExpired: isExpired,
        isUsedUp: isUsedUp,
        petName: petName
      };
    }
    return map;
  } catch (err) {
    Logger.log("loadMonthlyMap_ failed: " + err);
    return {};
  }
}

function parseDate_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value)) {
    return value;
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// 「0912-345-678」→「0912345678」；多電話用 / 分隔取第一支；非標準電話保留純數字
function normalizePhone_(text) {
  if (!text) return "";
  const first = String(text).split(/[\/,;|]/)[0];
  const cleaned = first.replace(/[^\d]/g, "");
  const m = cleaned.match(/09\d{8}/);
  if (m) return m[0];
  return cleaned;
}

// 「5,000」→ 5000；「5,000+1,000」→ 6000；「補1,500」→ 1500；空字串 → null
function parseAmount_(s) {
  const str = String(s == null ? "" : s).trim();
  if (!str) return null;
  const parts = str.split("+").map((p) => Number(p.replace(/[^\d.\-]/g, "")));
  let sum = 0;
  let any = false;
  for (const p of parts) {
    if (!isNaN(p)) { sum += p; any = true; }
  }
  return any ? sum : null;
}

function addPet_(pets, name, breed) {
  const petName = cleanText_(name);
  if (!petName) return;
  pets.push({ name: petName, breed: cleanText_(breed) });
}

function splitAlerts_(value) {
  return cleanText_(value)
    .split(/[;,，、\n\r]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function verifyLineAccessToken_(token) {
  if (!token) {
    throw new Error("缺少 LINE access token，請從 LINE 選單重新開啟");
  }

  const response = UrlFetchApp.fetch("https://api.line.me/v2/profile", {
    method: "get",
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error("LINE 身分驗證失敗，請重新開啟 LIFF");
  }

  return JSON.parse(response.getContentText());
}

function getParam_(e, name) {
  if (!e || !e.parameter) return "";
  return String(e.parameter[name] || "").trim();
}

function cleanText_(value) {
  return String(value == null ? "" : value).trim();
}

function toNumber_(value) {
  if (value === "" || value === null || value === undefined) return 0;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function formatDate_(value) {
  if (!value) return "";
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return cleanText_(value);
}

function formatDateTime_(value) {
  if (!value) return "";
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");
  }
  return cleanText_(value);
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 第一次貼到 Apps Script 後請執行一次。
 * 觸發 Google 授權允許讀取容器綁定試算表 + 開啟檔案 B + 呼叫 LINE API。
 * 4/30 後改讀檔案 B 算餘額，新增 SpreadsheetApp.openByUrl 範圍要重新授權，必跑！
 */
function authorizeServices() {
  SpreadsheetApp.getActiveSpreadsheet().getName();
  SpreadsheetApp.openByUrl(FILE_B_URL).getName();
  UrlFetchApp.fetch("https://api.line.me/v2/profile", {
    method: "get",
    headers: { Authorization: "Bearer test" },
    muteHttpExceptions: true
  });
}

/**
 * 出事時編輯器跑一次，30 秒看出斷點。
 * 5/3 LIFF Failed to fetch 那次要走「testReadCustomers → 看紅字」推根因，現在直接看這支報告。
 * 驗：(1) 容器檔案 A (2) 檔案 B (3) LINE API 連通性
 */
function selfCheck() {
  const results = [];

  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error("找不到分頁：" + SHEET_NAME);
    results.push({ name: "容器檔案 A（" + SHEET_NAME + "）", ok: true, detail: sheet.getLastRow() + " 列" });
  } catch (e) {
    results.push({ name: "容器檔案 A（" + SHEET_NAME + "）", ok: false, detail: shortenErr_(e) });
  }

  try {
    const sheet = SpreadsheetApp.openByUrl(FILE_B_URL).getSheetByName(SHEET_LEDGER);
    if (!sheet) throw new Error("找不到分頁：" + SHEET_LEDGER);
    results.push({ name: "檔案 B（" + SHEET_LEDGER + "）", ok: true, detail: sheet.getLastRow() + " 列" });
  } catch (e) {
    results.push({ name: "檔案 B（" + SHEET_LEDGER + "）", ok: false, detail: shortenErr_(e) });
  }

  // 包月分頁是 5/6 才開的，找不到不算 fail（顯示 SKIP），只有「找到但讀失敗」才 fail
  try {
    const sheet = SpreadsheetApp.openByUrl(FILE_B_URL).getSheetByName(SHEET_MONTHLY);
    if (!sheet) {
      results.push({ name: "檔案 B（" + SHEET_MONTHLY + "）", ok: true, detail: "分頁不存在（包月功能未啟用，正常）" });
    } else {
      const map = loadMonthlyMap_();
      const activeCount = Object.values(map).filter((m) => m.isActive).length;
      results.push({ name: "檔案 B（" + SHEET_MONTHLY + "）", ok: true, detail: sheet.getLastRow() + " 列｜包月中 " + activeCount + " 位" });
    }
  } catch (e) {
    results.push({ name: "檔案 B（" + SHEET_MONTHLY + "）", ok: false, detail: shortenErr_(e) });
  }

  try {
    const res = UrlFetchApp.fetch("https://api.line.me/v2/profile", {
      method: "get",
      headers: { Authorization: "Bearer test" },
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    // 401 是預期（test token 無效），代表網路通；非 200/401 才算可疑
    const ok = code === 200 || code === 401;
    results.push({ name: "LINE API 連通性", ok: ok, detail: "HTTP " + code + (ok ? "（網路通）" : "") });
  } catch (e) {
    results.push({ name: "LINE API 連通性", ok: false, detail: shortenErr_(e) });
  }

  const lines = ["=== selfCheck (pet-grooming) ==="];
  for (const r of results) {
    lines.push((r.ok ? "✓ " : "✗ ") + r.name + "：" + r.detail);
  }
  Logger.log(lines.join("\n"));
  return results;
}

function shortenErr_(err) {
  return String((err && err.message) || err).substring(0, 200);
}

function testReadCustomers() {
  Logger.log(JSON.stringify(readCustomers_(), null, 2));
}

// 單獨測餘額來源：執行後在執行記錄裡查每位客戶餘額
function testBalanceMap() {
  const map = loadBalanceMap_();
  Logger.log("共 " + Object.keys(map).length + " 位客戶有餘額紀錄");
  Logger.log(JSON.stringify(map, null, 2));
}

// 單獨測包月來源：執行後在執行記錄裡查每位包月客戶狀態
function testMonthlyMap() {
  const map = loadMonthlyMap_();
  const total = Object.keys(map).length;
  const active = Object.values(map).filter((m) => m.isActive).length;
  const expired = Object.values(map).filter((m) => m.isExpired).length;
  const usedUp = Object.values(map).filter((m) => m.isUsedUp).length;
  Logger.log("共 " + total + " 位有包月紀錄｜進行中 " + active + "、已過期 " + expired + "、已用完 " + usedUp);
  Logger.log(JSON.stringify(map, null, 2));
}
