/**
 * LINE LIFF 客戶查詢 API
 *
 * Google Sheet 分頁名稱：客戶資料
 * 欄位：
 * A 電話
 * B 姓名
 * C 寵物1名
 * D 寵物1品種
 * E 寵物2
 * F 寵物2品種
 * G 重要提醒
 * H 美容備註
 * I 儲值金餘額
 * J 最近到店
 * K 建立時間
 * L 來源
 * M 本次服務
 * N 本次金額
 * O LINE_userId
 */

const SHEET_NAME = "客戶資料";

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

  return values
    .slice(1)
    .filter((row) => cleanText_(row[0]))
    .map(rowToCustomer_);
}

function rowToCustomer_(row) {
  const pets = [];
  addPet_(pets, row[2], row[3]);
  addPet_(pets, row[4], row[5]);

  return {
    phone: cleanText_(row[0]),
    name: cleanText_(row[1]),
    pets: pets,
    alerts: splitAlerts_(row[6]),
    notes: cleanText_(row[7]),
    balance: toNumber_(row[8]),
    lastVisit: formatDate_(row[9]),
    createdAt: formatDateTime_(row[10]),
    source: cleanText_(row[11]),
    currentService: cleanText_(row[12]),
    currentAmount: toNumber_(row[13]),
    lineUserId: cleanText_(row[14])
  };
}

function addPet_(pets, name, breed) {
  const petName = cleanText_(name);
  if (!petName) return;

  pets.push({
    name: petName,
    breed: cleanText_(breed)
  });
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
    headers: {
      Authorization: "Bearer " + token
    },
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
  return String(value || "").trim();
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
 * 第一次貼到 Apps Script 後，請手動執行這個函式一次。
 * 它會觸發 Google 授權，允許讀取試算表與呼叫 LINE 官方 API。
 */
function authorizeServices() {
  SpreadsheetApp.getActiveSpreadsheet().getName();
  UrlFetchApp.fetch("https://api.line.me/v2/profile", {
    method: "get",
    headers: {
      Authorization: "Bearer test"
    },
    muteHttpExceptions: true
  });
}

function testReadCustomers() {
  Logger.log(JSON.stringify(readCustomers_(), null, 2));
}
