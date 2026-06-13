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
 * 包月分頁 schema（檔案 B，13 欄；位置解析，header 不能亂改）：
 * A 日期 | B 電話 | C 客戶姓名 | D 寵物名 | E 服務 | F 本次狀態 |
 * G 金額 | H 已用次數 | I 剩餘 | J 到期日 | K 簽名 | L 備註 | M 卡別
 * （M 空白 = 預設卡，相容加欄前的舊資料）
 *
 * 卡別設定分頁 schema（檔案 B，選用；沒有此分頁 = 單一洗澡卡模式）：
 * A 卡名 | B 價格 | C 含次數 | D 期限天數 | E 適用服務 | F 顯示順序 | G 啟用
 */

const SHEET_NAME = "客戶資料";
const SHEET_GUEST_LOG = "服務紀錄";  // 檔案 A 散客結單寫入目標

// 檔案 B「寵物店儲值帳本」（跟 credit-liff Code.gs 同一個 URL）
const FILE_B_URL = "https://docs.google.com/spreadsheets/d/1yK6KNkOTJyaDiZMd5RxoZIDvOngQf6zgslN-H5Q-KaA/edit";
const SHEET_LEDGER = "交易明細";
const SHEET_MONTHLY = "包月客戶";
const SHEET_CARD_TYPES = "卡別設定";  // 選用分頁：多卡別（洗澡卡/剪毛卡…）；不存在則退回下面的單卡常數

// 「卡別設定」分頁不存在時的預設卡參數（向後相容：單卡店家不用動任何東西）
const MONTHLY_PACKAGE_DAYS = 45;
const MONTHLY_PACKAGE_USES = 5;
const MONTHLY_DEFAULT_PRICE = 1500;
const DEFAULT_CARD_NAME = "洗澡卡";

const ALLOWED_LINE_USER_IDS = {
  "Uc91d607de27558c937af89be42699678": "shan🌸",
  "U74ba014545211a09942ccc17bcc28e39": "Elio",
  "U61199309b9ff3f86b4872f1aeb147418": "美月兒",
  "Udb797fdc8b926bff6f972be748450ecb": "Jenny"
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
      cardTypes: loadCardTypes_(),
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    return json_({
      ok: false,
      message: err && err.message ? err.message : String(err)
    });
  }
}

/**
 * 結單 API：從 LIFF 結單頁 POST 來，按 type 寫進對應分頁。
 *
 * 共用 payload 欄位：
 *   action: "submit"
 *   token:  LINE access token（白名單驗證）
 *   type:   "guest" | "credit" | "monthly"
 *   note:   員工備註（optional）
 *
 * 各 type 額外欄位：
 *   guest:   { petName, amount, payment }            → 寫檔案 A「服務紀錄」
 *   credit:  { phone, petName, amount }              → 寫檔案 B「交易明細」
 *   monthly: { phone, petName, mode, amount?, cardType? } → 寫檔案 B「包月客戶」
 *            mode: "use"（扣次數）/ "new"（新購包月）
 *            cardType: 卡名（對應「卡別設定」分頁；舊前端沒給 = 預設卡）
 *
 * CORS 規避：前端用 Content-Type: text/plain 避開 preflight。
 */
function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw) return json_({ ok: false, message: "缺少 request body" });
    const data = JSON.parse(raw);

    if (data.action !== "submit") {
      return json_({ ok: false, message: "不支援的 action" });
    }

    const profile = verifyLineAccessToken_(data.token);
    if (!profile.userId || !ALLOWED_LINE_USER_IDS[profile.userId]) {
      return json_({ ok: false, code: "FORBIDDEN", message: "此帳號未授權，請聯絡店長" });
    }
    // 公用平板：員工自己選名字（覆蓋帳號白名單對應），沒選才 fallback
    const operatorName = cleanText_(data.operator) || ALLOWED_LINE_USER_IDS[profile.userId];

    if (data.type === "guest")   return submitGuest_(data, operatorName);
    if (data.type === "credit")  return submitCredit_(data, operatorName);
    if (data.type === "monthly") return submitMonthly_(data, operatorName);
    return json_({ ok: false, message: "未知 type：" + data.type });
  } catch (err) {
    return json_({ ok: false, message: err && err.message ? err.message : String(err) });
  }
}

// 散客 → 檔案 A「服務紀錄」
// schema: A 日期 | B 主人電話 | C 寵物名 | D 服務項目 | E 金額 | F 付款方式 | G 美容師 | H 備註
function submitGuest_(data, operatorName) {
  const petName = cleanText_(data.petName);
  const amount = Number(data.amount);
  if (!petName) return json_({ ok: false, message: "請填寵物名" });
  if (!Number.isFinite(amount) || amount <= 0) return json_({ ok: false, message: "金額需為正數" });

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_GUEST_LOG);
  if (!sheet) return json_({ ok: false, message: "找不到分頁：" + SHEET_GUEST_LOG });

  const phone = normalizePhone_(data.phone || "");
  const payment = cleanText_(data.payment) || "現金";
  const service = cleanText_(data.service) || "洗澡";  // 員工 LIFF 勾的服務（複選用「、」串），舊版客戶端沒給時 fallback
  const note = cleanText_(data.note);
  const noteWithFlag = note ? note + "（LIFF 結單）" : "（LIFF 結單）";

  const row = [
    new Date(),                         // A 日期
    phone,                              // B 主人電話（散客通常空）
    petName,                            // C 寵物名
    service,                            // D 服務項目
    amount,                             // E 金額
    payment,                            // F 付款方式
    operatorName,                       // G 美容師
    noteWithFlag                        // H 備註
  ];
  sheet.appendRow(row);

  // 強制 B 電話純文字格式防 09xxx 開頭 0 被吃掉
  if (phone) {
    sheet.getRange(sheet.getLastRow(), 2).setNumberFormat("@").setValue(phone);
  }

  return json_({
    ok: true,
    message: "已記錄散客 " + petName + " " + amount + " 元",
    summary: { petName: petName, amount: amount, payment: payment }
  });
}

// 儲值客戶 → 檔案 B「交易明細」
// schema: A 電話 | B 寵物名 | C 日期 | D 儲值金額 | E 消費項目 | F 消費金額 | G 餘額 | H 簽名 | I 備註
function submitCredit_(data, operatorName) {
  const phoneKey = normalizePhone_(data.phone);
  const petName = cleanText_(data.petName);
  const amount = Number(data.amount);
  if (!phoneKey) return json_({ ok: false, message: "缺少客戶電話" });
  if (!Number.isFinite(amount) || amount <= 0) return json_({ ok: false, message: "金額需為正數" });

  const balanceMap = loadBalanceMap_();
  const prevBalance = Number.isFinite(balanceMap[phoneKey]) ? balanceMap[phoneKey] : 0;
  const newBalance = prevBalance - amount;

  const sheet = SpreadsheetApp.openByUrl(FILE_B_URL).getSheetByName(SHEET_LEDGER);
  if (!sheet) return json_({ ok: false, message: "找不到分頁：" + SHEET_LEDGER });

  const service = cleanText_(data.service) || "洗澡";  // 員工 LIFF 勾的服務（複選用「、」串），舊版客戶端沒給時 fallback
  const note = cleanText_(data.note);
  const noteWithFlag = note ? note + "（LIFF 結單 by " + operatorName + "）" : "LIFF 結單 by " + operatorName;

  const row = [
    phoneKey,                           // A 電話
    petName,                            // B 寵物名
    new Date(),                         // C 日期
    "",                                 // D 儲值金額（消費不填）
    service,                            // E 消費項目
    amount,                             // F 消費金額
    newBalance,                         // G 餘額
    "（LIFF）",                         // H 簽名（無紙本簽名標記）
    noteWithFlag                        // I 備註
  ];
  sheet.appendRow(row);
  // 強制 A 電話純文字
  sheet.getRange(sheet.getLastRow(), 1).setNumberFormat("@").setValue(phoneKey);

  return json_({
    ok: true,
    message: "已扣 " + amount + " 元，剩 " + newBalance + " 元",
    summary: { petName: petName, amount: amount, prevBalance: prevBalance, newBalance: newBalance }
  });
}

// 包月客戶 → 檔案 B「包月客戶」
// schema: A 日期 | B 電話 | C 客戶姓名(填寵物名) | D 寵物名 | E 服務 | F 本次狀態 |
//         G 金額 | H 已用次數 | I 剩餘 | J 到期日 | K 簽名 | L 備註 | M 卡別
function submitMonthly_(data, operatorName) {
  const phoneKey = normalizePhone_(data.phone);
  const petName = cleanText_(data.petName);
  const mode = cleanText_(data.mode);  // "use" | "new"
  if (!phoneKey) return json_({ ok: false, message: "缺少客戶電話" });
  if (mode !== "use" && mode !== "new") return json_({ ok: false, message: "未知模式" });

  const cards = loadCardTypes_();
  const card = findCardType_(cards, data.cardType);
  if (!card) {
    return json_({ ok: false, message: "未知卡別：" + cleanText_(data.cardType) + "（請檢查「" + SHEET_CARD_TYPES + "」分頁）" });
  }

  const sheet = SpreadsheetApp.openByUrl(FILE_B_URL).getSheetByName(SHEET_MONTHLY);
  if (!sheet) return json_({ ok: false, message: "找不到分頁：" + SHEET_MONTHLY });

  const today = new Date();
  const service = cleanText_(data.service) || "洗澡";  // 員工 LIFF 勾的服務（複選用「、」串），舊版客戶端沒給時 fallback
  const note = cleanText_(data.note);
  const noteWithFlag = note ? note + "（LIFF 結單 by " + operatorName + "）" : "LIFF 結單 by " + operatorName;

  let row;
  let summary;
  if (mode === "new") {
    // 新購：H 已用 = 1（含當次）/ I 剩 = 卡含次數 - 1 / J 到期 = today + 卡期限天數
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json_({ ok: false, message: "新購需填金額" });
    }
    const expireDate = new Date(today.getTime() + card.days * 24 * 60 * 60 * 1000);
    row = [
      today,                            // A 日期
      phoneKey,                         // B 電話
      petName,                          // C 客戶姓名（填寵物名）
      petName,                          // D 寵物名
      service,                          // E 服務
      "新購",                           // F 本次狀態
      amount,                           // G 金額
      1,                                // H 已用次數（含當次）
      card.uses - 1,                    // I 剩餘
      expireDate,                       // J 到期日
      "（LIFF）",                       // K 簽名
      noteWithFlag,                     // L 備註
      card.name                         // M 卡別
    ];
    summary = {
      petName: petName,
      mode: "new",
      cardName: card.name,
      amount: amount,
      used: 1,
      remaining: card.uses - 1,
      expireDate: Utilities.formatDate(expireDate, Session.getScriptTimeZone(), "yyyy-MM-dd")
    };
  } else {
    // 扣次數：讀該客戶「該卡別」最近一筆狀態，已用+1 / 剩-1 / 到期日延用
    const monthlyMap = loadMonthlyMap_();
    const holder = monthlyMap[phoneKey];
    const status = holder && holder.cards ? holder.cards[card.name] : null;
    if (!status) return json_({ ok: false, message: "找不到「" + card.name + "」紀錄，請改用「新購」" });
    if (status.isExpired) return json_({ ok: false, message: "「" + card.name + "」已過期，請改用「新購」" });
    if (status.isUsedUp) return json_({ ok: false, message: "「" + card.name + "」次數已用完，請改用「新購」" });

    const newUsed = status.used + 1;
    const newRemaining = status.remaining - 1;  // 以上一筆剩餘為準（各卡別總次數不同，不可用全域常數回推）
    // 到期日延用上一筆（從字串轉回 Date）
    const expireParts = status.expireDate.split("-").map(Number);
    const expireDate = new Date(expireParts[0], expireParts[1] - 1, expireParts[2]);

    row = [
      today,
      phoneKey,
      petName,
      petName,
      service,
      "第 " + newUsed + " 次",          // F 本次狀態
      "",                               // G 金額（扣次數空白）
      newUsed,
      newRemaining,
      expireDate,
      "（LIFF）",
      noteWithFlag,
      card.name                         // M 卡別
    ];
    summary = {
      petName: petName,
      mode: "use",
      cardName: card.name,
      used: newUsed,
      remaining: newRemaining,
      expireDate: status.expireDate
    };
  }

  sheet.appendRow(row);
  sheet.getRange(sheet.getLastRow(), 2).setNumberFormat("@").setValue(phoneKey);

  return json_({
    ok: true,
    message: mode === "new"
      ? "已新購「" + card.name + "」，剩 " + summary.remaining + " 次"
      : "「" + card.name + "」已扣第 " + summary.used + " 次，剩 " + summary.remaining + " 次",
    summary: summary
  });
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

// 從檔案 B「包月客戶」算每位客戶「各卡別」的包月狀態（每張卡取最新一筆）
// 回傳: { phoneKey: { cards: { 卡名: status }, ...代表卡狀態攤平在頂層（向後相容單卡前端） } }
// status = { cardName, used, remaining, daysLeft, expireDate, isActive, isExpired, isUsedUp, petName }
function loadMonthlyMap_() {
  try {
    const sheet = SpreadsheetApp.openByUrl(FILE_B_URL).getSheetByName(SHEET_MONTHLY);
    if (!sheet) return {};
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return {};

    const cards = loadCardTypes_();
    const defaultCardName = cards.length ? cards[0].name : DEFAULT_CARD_NAME;

    // 包月分頁欄序：A 日期 | B 電話 | ... | L 備註 | M 卡別（M 空白 = 預設卡，舊資料相容）
    // 紙本可能不依日期順序貼進來，所以掃全表找每位客戶「每張卡」最新一筆
    const latest = {};
    for (let i = 1; i < data.length; i++) {
      const phoneKey = normalizePhone_(data[i][1]);
      if (!phoneKey) continue;
      const date = parseDate_(data[i][0]);
      if (!date) continue;
      const cardName = cleanText_(data[i][12]) || defaultCardName;
      const key = phoneKey + "||" + cardName;
      if (!latest[key] || date.getTime() > latest[key].date.getTime()) {
        latest[key] = { phoneKey: phoneKey, cardName: cardName, date: date, row: data[i] };
      }
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const msPerDay = 24 * 60 * 60 * 1000;
    const tz = Session.getScriptTimeZone();

    const map = {};
    for (const key in latest) {
      const item = latest[key];
      const row = item.row;
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
      const isUsedUp = remaining <= 0;  // 各卡別總次數不同，不可寫死 used >= 5
      const isActive = !isExpired && !isUsedUp;

      const status = {
        cardName: item.cardName,
        used: used,
        remaining: remaining,
        daysLeft: daysLeft,
        expireDate: Utilities.formatDate(expireMidnight, tz, "yyyy-MM-dd"),
        isActive: isActive,
        isExpired: isExpired,
        isUsedUp: isUsedUp,
        petName: petName
      };
      if (!map[item.phoneKey]) map[item.phoneKey] = { cards: {} };
      map[item.phoneKey].cards[item.cardName] = status;
    }

    // 挑一張「代表卡」攤平到頂層：優先有效卡，其次到期日最晚（舊前端/單卡店家讀頂層即可）
    for (const phoneKey in map) {
      const cardMap = map[phoneKey].cards;
      let best = null;
      for (const cn in cardMap) {
        const s = cardMap[cn];
        if (!best ||
            (s.isActive && !best.isActive) ||
            (s.isActive === best.isActive && s.expireDate > best.expireDate)) {
          best = s;
        }
      }
      if (best) {
        for (const k in best) map[phoneKey][k] = best[k];
      }
    }
    return map;
  } catch (err) {
    Logger.log("loadMonthlyMap_ failed: " + err);
    return {};
  }
}

// 讀檔案 B「卡別設定」分頁；分頁不存在或無有效列 → 回傳預設單一洗澡卡（向後相容）
// 欄序：A 卡名 | B 價格 | C 含次數 | D 期限天數 | E 適用服務 | F 顯示順序 | G 啟用
function loadCardTypes_() {
  const fallback = [{
    name: DEFAULT_CARD_NAME,
    price: MONTHLY_DEFAULT_PRICE,
    uses: MONTHLY_PACKAGE_USES,
    days: MONTHLY_PACKAGE_DAYS,
    services: ""
  }];
  try {
    const sheet = SpreadsheetApp.openByUrl(FILE_B_URL).getSheetByName(SHEET_CARD_TYPES);
    if (!sheet) return fallback;
    const data = sheet.getDataRange().getValues();
    const cards = [];
    for (let i = 1; i < data.length; i++) {
      const name = cleanText_(data[i][0]);
      const uses = Number(data[i][2]);
      const days = Number(data[i][3]);
      if (!name || !Number.isFinite(uses) || uses <= 0 || !Number.isFinite(days) || days <= 0) continue;
      const enabled = cleanText_(data[i][6]);
      if (/^(否|no|n|0|false|x|✗|✘)$/i.test(enabled)) continue;  // 空白視為啟用
      cards.push({
        name: name,
        price: parseAmount_(data[i][1]) || 0,
        uses: uses,
        days: days,
        services: cleanText_(data[i][4]),
        order: Number(data[i][5]) || 999
      });
    }
    if (!cards.length) return fallback;
    cards.sort(function (a, b) { return a.order - b.order; });
    return cards;
  } catch (err) {
    Logger.log("loadCardTypes_ failed: " + err);
    return fallback;
  }
}

// 按卡名找卡別定義；沒給卡名 = 預設卡（第一張，向後相容舊前端）；找不到 = null
function findCardType_(cards, name) {
  const key = cleanText_(name);
  if (!key) return cards[0] || null;
  for (let i = 0; i < cards.length; i++) {
    if (cards[i].name === key) return cards[i];
  }
  return null;
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

  // 5/12 起多一個結單寫入目標：服務紀錄（散客結單寫這裡）
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_GUEST_LOG);
    if (!sheet) throw new Error("找不到分頁：" + SHEET_GUEST_LOG + "（散客結單會失敗）");
    results.push({ name: "容器檔案 A（" + SHEET_GUEST_LOG + "）", ok: true, detail: sheet.getLastRow() + " 列｜散客結單目標" });
  } catch (e) {
    results.push({ name: "容器檔案 A（" + SHEET_GUEST_LOG + "）", ok: false, detail: shortenErr_(e) });
  }

  try {
    const sheet = SpreadsheetApp.openByUrl(FILE_B_URL).getSheetByName(SHEET_LEDGER);
    if (!sheet) throw new Error("找不到分頁：" + SHEET_LEDGER);
    results.push({ name: "檔案 B（" + SHEET_LEDGER + "）", ok: true, detail: sheet.getLastRow() + " 列｜儲值結單目標" });
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
      results.push({ name: "檔案 B（" + SHEET_MONTHLY + "）", ok: true, detail: sheet.getLastRow() + " 列｜包月中 " + activeCount + " 位｜結單目標" });
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
