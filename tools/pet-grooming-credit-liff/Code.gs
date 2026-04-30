/**
 * 寵美客戶儲值選單 LIFF 後端 — 純 API
 *
 * 提供：
 *   GET  ?action=health              健康檢查
 *   GET  ?action=getMyCredit&liffUserId=Uxxx
 *                                    撈該客戶餘額 / 最後消費日 / 最近 5 筆
 *   GET  ?action=getPlans            撈儲值方案（從「方案設定」分頁）
 *   POST { action:"requestTopup", liffUserId, planName, payAmount, bonusAmount }
 *                                    客戶按「我要儲值」→ 推老闆 LINE + 寫 log
 *
 * 資料源：
 *   - 檔案 A（既有客戶資料）：用 LINE_userId 反查電話 + 姓名
 *   - 檔案 B（新建儲值帳本）：交易明細 / 方案設定 / 儲值申請 log
 *
 * 部署流程詳見 部署指南.md
 */

// ========== ⚠️ 必改區 ==========
// 檔案 A 網址（既有客戶資料；只讀，不寫）— 跟 pet-grooming-liff 同一份
const FILE_A_URL = "https://docs.google.com/spreadsheets/d/1jkgtipEu0bsBcGU7yyeBl7_tZzdp5P9Iaezq1e6gq60/edit";
// 檔案 B 網址（新建的「寵物店儲值帳本」）
const FILE_B_URL = "https://docs.google.com/spreadsheets/d/1yK6KNkOTJyaDiZMd5RxoZIDvOngQf6zgslN-H5Q-KaA/edit";
// ================================

const SHEET_CUSTOMER = "客戶資料";        // 檔案 A
const SHEET_SUMMARY  = "客戶總覽";         // 檔案 B
const SHEET_LEDGER   = "交易明細";         // 檔案 B
const SHEET_PLANS    = "方案設定";         // 檔案 B
const SHEET_REQ_LOG  = "儲值申請 log";     // 檔案 B

// ============================================================
// 入口
// ============================================================
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "";

  if (action === "health" || (e && e.parameter && e.parameter.health)) {
    return json({ ok: true, service: "pet-grooming-credit-liff", ts: new Date().toISOString() });
  }
  if (action === "getMyCredit") {
    return getMyCredit((e.parameter && e.parameter.liffUserId) || "");
  }
  if (action === "getPlans") {
    return getPlans();
  }
  return json({ ok: true, service: "pet-grooming-credit-liff", note: "API only" });
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw) return json({ error: "no_body" });
    const data = JSON.parse(raw);

    if (data.action === "requestTopup") {
      return requestTopup(data);
    }
    return json({ error: "unknown_action" });
  } catch (err) {
    return json({ error: String((err && err.message) || err) });
  }
}

// ============================================================
// API：撈客戶自己的儲值狀態
// ============================================================
function getMyCredit(liffUserId) {
  if (!liffUserId) return json({ error: "missing_liffUserId" });

  const ident = lookupCustomerByLiffUserId(liffUserId);
  if (!ident) {
    return json({
      registered: false,
      message: "您還沒在我們系統登記過。請先填寫「寵美資訊登記」表單。",
    });
  }

  const txs = listTxsByPhone(ident.phone);

  // 目前餘額 = 最後一筆有「餘額」欄非空的
  let currentBalance = 0;
  for (let i = txs.length - 1; i >= 0; i--) {
    const b = parseAmount(txs[i].balance);
    if (b !== null) { currentBalance = b; break; }
  }

  // 最後消費日 = 最後一筆有「消費金額」欄非空的
  let lastSpentDate = "";
  for (let i = txs.length - 1; i >= 0; i--) {
    if (String(txs[i].spent || "").trim()) { lastSpentDate = String(txs[i].date || ""); break; }
  }

  // 最近 5 筆（最新在最前）
  const recent = txs.slice(-5).reverse();

  return json({
    registered: true,
    name: ident.name,
    phone: ident.phone,
    currentBalance: currentBalance,
    lastSpentDate: lastSpentDate,
    txnCount: txs.length,
    recent: recent.map(t => ({
      date: String(t.date || ""),
      topup: String(t.topup || ""),
      item: String(t.item || ""),
      spent: String(t.spent || ""),
      balance: String(t.balance || ""),
    })),
  });
}

// ============================================================
// API：撈方案設定
// ============================================================
function getPlans() {
  const sheet = openLedger().getSheetByName(SHEET_PLANS);
  if (!sheet) return json({ error: "sheet_not_found", sheet: SHEET_PLANS });

  const data = sheet.getDataRange().getValues();
  const plans = [];
  // headers: 方案名 | 儲值金額 | 贈送金額 | 期限天數 | 顯示順序 | 啟用
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    const enabled = row[5];
    const enabledBool = (enabled === true || String(enabled).toUpperCase() === "TRUE");
    if (!enabledBool) continue;
    plans.push({
      name: String(row[0]),
      payAmount: Number(row[1]) || 0,
      bonusAmount: Number(row[2]) || 0,
      validDays: Number(row[3]) || 0,
      order: Number(row[4]) || 0,
    });
  }
  plans.sort((a, b) => a.order - b.order);
  return json({ plans: plans });
}

// ============================================================
// API：客戶申請儲值 → 推老闆 LINE + 寫 log
// ============================================================
function requestTopup(data) {
  const liffUserId = String(data.liffUserId || "").trim();
  if (!liffUserId) return json({ error: "missing_liffUserId" });

  const planName = String(data.planName || "").trim();
  const payAmount = Number(data.payAmount) || 0;
  const bonusAmount = Number(data.bonusAmount) || 0;
  if (!planName || !payAmount) return json({ error: "missing_plan" });

  const ident = lookupCustomerByLiffUserId(liffUserId);
  if (!ident) {
    return json({ registered: false, message: "您還沒登記過，請先填寫「寵美資訊登記」表單。" });
  }

  const tsStr = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  const total = payAmount + bonusAmount;
  const text =
    "💰 客戶申請儲值\n" +
    "客戶：" + ident.name + "\n" +
    "電話：" + ident.phone + "\n" +
    "方案：" + planName + "\n" +
    "金額：NT$" + payAmount.toLocaleString() +
       "（贈 " + bonusAmount.toLocaleString() + "，總計 " + total.toLocaleString() + "）\n" +
    "時間：" + tsStr + "\n" +
    "→ 請聯絡客戶確認付款方式";

  let pushStatus = "ok";
  let errorMsg = "";
  try {
    if (!pushLine(text)) { pushStatus = "push_failed"; errorMsg = "pushLine returned false"; }
  } catch (e) {
    pushStatus = "push_failed";
    errorMsg = String((e && e.message) || e);
  }

  // 寫 log（不論推播成敗都寫一筆）
  try {
    const logSheet = openLedger().getSheetByName(SHEET_REQ_LOG);
    if (logSheet) {
      logSheet.appendRow([
        new Date(),         // A 申請時間
        ident.name,         // B 客戶姓名
        ident.phone,        // C 電話
        planName,           // D 方案名
        payAmount,          // E 儲值金額
        bonusAmount,        // F 贈送金額
        liffUserId,         // G LINE_userId
        pushStatus,         // H 推播狀態
        "",                 // I 處理狀態（老闆手填）
      ]);
    }
  } catch (e) {
    Logger.log("[requestTopup] write log failed: " + e);
  }

  return json({
    ok: pushStatus === "ok",
    pushStatus: pushStatus,
    errorMsg: errorMsg,
    message: pushStatus === "ok"
      ? "已通知店家，請等候聯絡確認付款"
      : "已記錄申請，但通知店家失敗，請直接聯絡店家",
  });
}

// ============================================================
// 重算「客戶總覽」分頁（手動或 trigger 排程觸發）
// ============================================================
function recomputeSummary() {
  const ledger = openLedger();
  const txSheet = ledger.getSheetByName(SHEET_LEDGER);
  const sumSheet = ledger.getSheetByName(SHEET_SUMMARY);
  if (!txSheet || !sumSheet) throw new Error("找不到必要分頁");

  const txData = txSheet.getDataRange().getValues();
  // headers: 電話 | 客戶姓名 | 日期 | 儲值金額 | 消費項目 | 消費金額 | 餘額 | 簽名 | 備註

  // 以電話為 key 收集每位客戶的資料
  const byPhone = {};
  for (let i = 1; i < txData.length; i++) {
    const phoneRaw = String(txData[i][0] || "").trim();
    if (!phoneRaw) continue;
    const phoneNorm = normalizePhone(phoneRaw);
    if (!phoneNorm) continue;
    if (!byPhone[phoneNorm]) {
      byPhone[phoneNorm] = {
        phoneRaw: phoneRaw,
        name: String(txData[i][1] || ""),
        balance: 0,
        spentCount: 0,
        lastSpentDate: "",
      };
    }
    const c = byPhone[phoneNorm];
    if (String(txData[i][1] || "").trim()) c.name = String(txData[i][1]);
    const balance = parseAmount(txData[i][6]);
    if (balance !== null) c.balance = balance;
    if (String(txData[i][5] || "").trim()) {
      c.spentCount += 1;
      c.lastSpentDate = String(txData[i][2] || "");
    }
  }

  // 寫入客戶總覽（先把舊資料清掉，保留 header）
  const lastRow = sumSheet.getLastRow();
  if (lastRow > 1) sumSheet.getRange(2, 1, lastRow - 1, 8).clearContent();

  const phones = Object.keys(byPhone);
  const rows = phones.map((p, idx) => {
    const c = byPhone[p];
    return [idx + 1, c.name, c.phoneRaw, "", c.balance, c.spentCount, c.lastSpentDate, ""];
  });
  if (rows.length) {
    sumSheet.getRange(2, 1, rows.length, 8).setValues(rows);
  }

  Logger.log("recomputeSummary: " + rows.length + " customers");
}

// ============================================================
// 把檔案 B「客戶總覽」中還沒在檔案 A「客戶資料」的客戶補進去
// 已存在的不動（不覆蓋老闆手填的資料）。Idempotent，可重跑。
// 4/30 灌完 21 位儲值客戶後跑一次，員工查詢頁就找得到他們了。
// ============================================================
function syncCreditCustomersToFileA() {
  const fileA = openCustomerFile().getSheetByName(SHEET_CUSTOMER);
  const fileB = openLedger().getSheetByName(SHEET_SUMMARY);
  if (!fileA || !fileB) throw new Error("找不到必要分頁");

  // 讀檔案 A 既有電話（normalize 後）
  const aData = fileA.getDataRange().getValues();
  const aHeaders = aData[0].map(h => String(h || "").trim());
  const phoneColA = aHeaders.indexOf("電話");
  if (phoneColA < 0) throw new Error("檔案 A 找不到「電話」欄");
  const existing = new Set();
  for (let i = 1; i < aData.length; i++) {
    const p = normalizePhone(aData[i][phoneColA]);
    if (p) existing.add(p);
  }

  // 讀檔案 B 客戶總覽
  // 欄序：# | 客戶姓名 | 電話 | 寵物 | 目前餘額 | 消費筆數 | 最後消費日 | 備註
  const bData = fileB.getDataRange().getValues();
  const newRows = [];
  let skipped = 0;
  for (let i = 1; i < bData.length; i++) {
    const phoneRaw = String(bData[i][2] || "").trim();
    if (!phoneRaw) continue;
    const phoneKey = normalizePhone(phoneRaw);
    if (!phoneKey) continue;
    if (existing.has(phoneKey)) { skipped++; continue; }

    const name = String(bData[i][1] || "").trim();
    const petStr = String(bData[i][3] || "").trim();
    const petParts = petStr.split("/").map(s => s.trim()).filter(Boolean);
    const pet1 = petParts[0] || "";
    const pet2 = petParts[1] || "";
    const extraPets = petParts.slice(2).join("、");

    // 雙電話：第一支當主電話（normalize 純數字），其他放美容備註
    const phoneParts = phoneRaw.split("/").map(s => s.trim()).filter(Boolean);
    const primaryPhone = normalizePhone(phoneParts[0] || "");  // 0910960624
    const extraPhones = phoneParts.slice(1).map(p => normalizePhone(p)).filter(Boolean);

    const noteParts = [];
    if (extraPhones.length) noteParts.push("另有電話：" + extraPhones.join("、"));
    if (extraPets) noteParts.push("另有寵物：" + extraPets);
    const notes = noteParts.join("；");

    // 用檔案 A 的 header 順序組 row（header-based，欄序動了不會壞）
    const row = aHeaders.map(h => {
      switch (h) {
        case "電話":     return primaryPhone;
        case "姓名":     return name;
        case "寵物1名":  return pet1;
        case "寵物2":    return pet2;
        case "美容備註": return notes;
        case "建立時間": return new Date();
        case "來源":     return "儲值帳本同步";
        default:         return "";
      }
    });
    newRows.push({ row: row, phone: primaryPhone });
    existing.add(phoneKey);
  }

  // 一次 append 完所有新增列
  if (newRows.length) {
    const startRow = fileA.getLastRow() + 1;
    fileA.getRange(startRow, 1, newRows.length, aHeaders.length)
         .setValues(newRows.map(x => x.row));
    // 強制電話欄文字格式 + 重寫值（防 09xxx 開頭 0 被吃掉，跟 LIFF upsert 同套防呆）
    for (let i = 0; i < newRows.length; i++) {
      fileA.getRange(startRow + i, phoneColA + 1)
           .setNumberFormat("@")
           .setValue(newRows[i].phone);
    }
  }

  Logger.log("syncCreditCustomersToFileA: 新增 " + newRows.length + " 位，跳過既有 " + skipped + " 位");
  return { added: newRows.length, skipped: skipped };
}

// ============================================================
// 一次性修：把「儲值帳本同步」來源的列電話從 0910-960-624 改成 0910960624
// + 雙電話客戶把第二支搬到美容備註
// 4/30 第一版 sync 寫了帶橫線格式違反資料驗證，跑這個函式清理。Idempotent。
// ============================================================
function fixSyncedPhonesFormat() {
  const fileA = openCustomerFile().getSheetByName(SHEET_CUSTOMER);
  if (!fileA) throw new Error("找不到客戶資料分頁");

  const data = fileA.getDataRange().getValues();
  const headers = data[0].map(h => String(h || "").trim());
  const phoneCol = headers.indexOf("電話");
  const sourceCol = headers.indexOf("來源");
  const notesCol = headers.indexOf("美容備註");
  if (phoneCol < 0 || sourceCol < 0 || notesCol < 0) {
    throw new Error("找不到必要欄位（電話/來源/美容備註）");
  }

  let fixed = 0;
  for (let i = 1; i < data.length; i++) {
    const source = String(data[i][sourceCol] || "").trim();
    if (source !== "儲值帳本同步") continue;

    const phoneRaw = String(data[i][phoneCol] || "").trim();
    if (!phoneRaw) continue;

    const phoneParts = phoneRaw.split("/").map(s => s.trim()).filter(Boolean);
    const primary = normalizePhone(phoneParts[0] || "");
    const extras = phoneParts.slice(1).map(p => normalizePhone(p)).filter(Boolean);

    if (!primary || primary === phoneRaw) continue;  // 已是純數字格式，跳過

    // 寫純數字電話 + 強制文字格式
    const r = i + 1;  // 1-based
    fileA.getRange(r, phoneCol + 1).setNumberFormat("@").setValue(primary);

    // 雙電話：第二支 prepend 進美容備註
    if (extras.length) {
      const existingNotes = String(data[i][notesCol] || "").trim();
      const extraNote = "另有電話：" + extras.join("、");
      const merged = existingNotes
        ? (existingNotes.indexOf(extraNote) >= 0 ? existingNotes : extraNote + "；" + existingNotes)
        : extraNote;
      fileA.getRange(r, notesCol + 1).setValue(merged);
    }
    fixed++;
  }

  Logger.log("fixSyncedPhonesFormat: 修了 " + fixed + " 列");
  return { fixed: fixed };
}

// ============================================================
// 工具函式
// ============================================================
function openCustomerFile() { return SpreadsheetApp.openByUrl(FILE_A_URL); }
function openLedger()       { return SpreadsheetApp.openByUrl(FILE_B_URL); }

function lookupCustomerByLiffUserId(liffUserId) {
  const sheet = openCustomerFile().getSheetByName(SHEET_CUSTOMER);
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h || "").trim());
  const phoneCol = headers.indexOf("電話");
  const nameCol = headers.indexOf("姓名");
  const userIdCol = headers.indexOf("LINE_userId");
  if (phoneCol < 0 || userIdCol < 0) return null;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][userIdCol] || "").trim() === liffUserId) {
      return {
        phone: String(data[i][phoneCol] || "").trim(),
        name: nameCol >= 0 ? String(data[i][nameCol] || "") : "",
      };
    }
  }
  return null;
}

function listTxsByPhone(phone) {
  const phoneNorm = normalizePhone(phone);
  if (!phoneNorm) return [];
  const sheet = openLedger().getSheetByName(SHEET_LEDGER);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  const txs = [];
  for (let i = 1; i < data.length; i++) {
    if (normalizePhone(data[i][0]) === phoneNorm) {
      txs.push({
        phone: data[i][0],
        name: data[i][1],
        date: data[i][2],
        topup: data[i][3],
        item: data[i][4],
        spent: data[i][5],
        balance: data[i][6],
        sign: data[i][7],
        note: data[i][8],
      });
    }
  }
  return txs;
}

// 「0919-665-794」→「0919665794」；多電話用 / 分隔的取**第一支**
function normalizePhone(text) {
  if (!text) return "";
  const first = String(text).split(/[\/,;|]/)[0];
  const cleaned = first.replace(/[^\d]/g, "");
  // 09xxxxxxxx 優先
  const m = cleaned.match(/09\d{8}/);
  if (m) return m[0];
  // 否則回原始純數字（給「022-980-79」這種非標準格式留路）
  return cleaned;
}

// 「5,000」→ 5000；「5,000+1,000」→ 6000；空字串 → null
function parseAmount(s) {
  const str = String(s == null ? "" : s).trim();
  if (!str) return null;
  // 拆 + 號加總
  const parts = str.split("+").map(p => Number(p.replace(/[^\d.\-]/g, "")));
  let sum = 0;
  let any = false;
  for (const p of parts) {
    if (!isNaN(p)) { sum += p; any = true; }
  }
  return any ? sum : null;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// LINE 推播（從 ScriptProperties 讀 token；跟其他工具同一套）
// ============================================================
function pushLine(text) {
  const props = PropertiesService.getScriptProperties();
  const TOKEN = props.getProperty("LINE_TOKEN");
  const TO = props.getProperty("BOSS_USER_ID");
  if (!TOKEN || !TO) {
    Logger.log("[pushLine] LINE_TOKEN 或 BOSS_USER_ID 未設定");
    return false;
  }
  const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
    method: "post",
    contentType: "application/json",
    headers: { "Authorization": "Bearer " + TOKEN },
    payload: JSON.stringify({
      to: TO,
      messages: [{ type: "text", text: String(text).substring(0, 4900) }],
    }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    Logger.log("[pushLine] HTTP " + code + " body=" + res.getContentText().substring(0, 300));
    return false;
  }
  return true;
}

// ============================================================
// 測試函式（在 Apps Script 編輯器執行）
// ============================================================
function testGetPlans() {
  Logger.log(getPlans().getContent());
}

function testGetMyCredit() {
  // 改成測試用的 liffUserId（請填一筆既有客戶的 LINE_userId）
  Logger.log(getMyCredit("PUT_TEST_LIFF_USER_ID_HERE").getContent());
}

function testRequestTopup() {
  const result = requestTopup({
    liffUserId: "PUT_TEST_LIFF_USER_ID_HERE",
    planName: "推薦",
    payAmount: 5000,
    bonusAmount: 600,
  });
  Logger.log(result.getContent());
}

function testRecomputeSummary() {
  recomputeSummary();
}

function testPushLine() {
  Logger.log("ok=" + pushLine("🧪 [credit-liff] 測試 " + new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })));
}
