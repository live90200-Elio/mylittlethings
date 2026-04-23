/**
 * 寵美管理 — 老闆私藏儀表板 後端 API
 *
 * 部署步驟（只有老闆能做，用老闆 Google 帳號）：
 *   1. 建一個新的試算表「檔案 B：老闆私藏報表」（可以是空的，反正主要靠 Apps Script）
 *   2. 在檔案 B 裡 → 擴充功能 → Apps Script
 *   3. 把這份 Code.gs 整個貼進去
 *   4. 改下面兩個常數（⚠️ 必改）：
 *      - FILE_A_URL：檔案 A 的完整網址
 *      - BOSS_KEY：長度 12+ 的亂碼，當密碼用
 *   5. 儲存 → 執行 testDoGet（第一次會彈授權，按允許）
 *   6. 部署 → 新增部署 → 網頁應用程式
 *      - 執行身分：我（老闆帳號）
 *      - 存取權：任何人
 *   7. 複製 /exec 網址，貼到 index.html 的 BOSS_API_URL
 *
 * 🔒 為什麼存取權是「任何人」但還能保密？
 *    Apps Script 用 BOSS_KEY 密碼驗證。沒帶正確 key 的請求會被拒絕。
 *    所以 Apps Script 網址本身可以公開，但 BOSS_KEY 只有老闆知道。
 */

// ========== ⚠️ 必改區 ==========
const FILE_A_URL = "https://docs.google.com/spreadsheets/d/1jkgtipEu0bsBcGU7yyeBl7_tZzdp5P9Iaezq1e6gq60/edit"; // ← 檔案 A 網址
const BOSS_KEY = "change-me-to-random-long-string"; // ← 老闆自訂的密碼（長亂碼）
// ================================

const SHEET_SERVICE = "服務紀錄";
const SHEET_CUSTOMER = "客戶資料";

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};

    if (!params.key || params.key !== BOSS_KEY) {
      return json({ error: "auth_failed", message: "密碼錯誤或未提供" });
    }

    const fileA = SpreadsheetApp.openByUrl(FILE_A_URL);
    const serviceSheet = fileA.getSheetByName(SHEET_SERVICE);
    const customerSheet = fileA.getSheetByName(SHEET_CUSTOMER);

    if (!serviceSheet) return json({ error: `找不到工作表：${SHEET_SERVICE}` });
    if (!customerSheet) return json({ error: `找不到工作表：${SHEET_CUSTOMER}` });

    const customerMap = buildCustomerMap(customerSheet);
    const records = readServiceRecords(serviceSheet, customerMap);

    const range = getPeriodRange(params.period || "current_month", params.from, params.to);

    // 若 range.to 在未來（例如「本月」範圍是 4/1~4/30，但今天才 4/22），截到今天為止，
    // 這樣和「去年同期」比較才公平（MTD vs 去年同期 MTD）
    const now = new Date();
    const effectiveTo = range.to > now ? now : range.to;
    const filtered = records.filter((r) => r.date >= range.from && r.date <= effectiveTo);

    const totalRevenue = sumBy(filtered, "amount");
    const count = filtered.length;

    // 去年同期（把兩端都減一年）
    const lastYearFrom = new Date(range.from); lastYearFrom.setFullYear(lastYearFrom.getFullYear() - 1);
    const lastYearTo = new Date(effectiveTo);   lastYearTo.setFullYear(lastYearTo.getFullYear() - 1);
    const lastYearFiltered = records.filter((r) => r.date >= lastYearFrom && r.date <= lastYearTo);
    const lastYearRevenue = sumBy(lastYearFiltered, "amount");
    const lastYearCount = lastYearFiltered.length;
    const growthPct = lastYearRevenue > 0
      ? Math.round(((totalRevenue - lastYearRevenue) / lastYearRevenue) * 1000) / 10
      : null;

    const sortedRecords = filtered
      .slice()
      .sort((a, b) => b.date - a.date)
      .map((r) => ({ ...r, date: formatDate(r.date) }));

    return json({
      period: {
        from: formatDate(range.from),
        to: formatDate(effectiveTo),
        label: range.label,
      },
      totalRevenue: totalRevenue,
      transactionCount: count,
      avgPerTransaction: count ? Math.round(totalRevenue / count) : 0,
      comparison: {
        lastYearRevenue: lastYearRevenue,
        lastYearCount: lastYearCount,
        growthPct: growthPct,
        label: "去年同期",
      },
      byGroomer: groupBy(filtered, "groomer"),
      byPayment: groupBy(filtered, "payment"),
      records: sortedRecords,
      storedValuePool: getStoredValuePool(customerSheet),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json({ error: String((err && err.message) || err) });
  }
}

function buildCustomerMap(sheet) {
  const values = sheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const phone = String(row[0] || "").trim();
    if (phone) map[phone] = { name: String(row[1] || "").trim() };
  }
  return map;
}

function readServiceRecords(sheet, customerMap) {
  // 欄位對照：A=日期 B=主人電話 C=寵物名 D=服務項目 E=金額 F=付款方式 G=負責美容師 H=備註
  const values = sheet.getDataRange().getValues();
  const records = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row[0]) continue;
    const date = row[0] instanceof Date ? row[0] : new Date(row[0]);
    if (isNaN(date.getTime())) continue;

    const phone = String(row[1] || "").trim();
    const customer = customerMap[phone] || { name: "" };

    records.push({
      date: date,
      phone: phone,
      ownerName: customer.name,
      petName: String(row[2] || "").trim(),
      service: String(row[3] || "").trim(),
      amount: Number(row[4]) || 0,
      payment: String(row[5] || "").trim() || "(未填)",
      groomer: String(row[6] || "").trim() || "(未填)",
      notes: String(row[7] || "").trim(),
    });
  }
  return records;
}

function getPeriodRange(period, customFrom, customTo) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  switch (period) {
    case "current_month":
      return { from: new Date(y, m, 1), to: new Date(y, m + 1, 0, 23, 59, 59), label: `${y} 年 ${m + 1} 月` };
    case "last_month":
      return { from: new Date(y, m - 1, 1), to: new Date(y, m, 0, 23, 59, 59), label: `${m === 0 ? y - 1 : y} 年 ${m === 0 ? 12 : m} 月` };
    case "current_year":
      return { from: new Date(y, 0, 1), to: new Date(y, 11, 31, 23, 59, 59), label: `${y} 年全年` };
    case "last_7_days": {
      const from = new Date(y, m, now.getDate() - 6);
      return { from: from, to: new Date(y, m, now.getDate(), 23, 59, 59), label: "最近 7 天" };
    }
    case "custom":
      if (customFrom && customTo) {
        return {
          from: new Date(customFrom + "T00:00:00"),
          to: new Date(customTo + "T23:59:59"),
          label: `${customFrom} ~ ${customTo}`,
        };
      }
  }
  return { from: new Date(y, m, 1), to: new Date(y, m + 1, 0, 23, 59, 59), label: `${y} 年 ${m + 1} 月` };
}

function sumBy(arr, key) {
  return arr.reduce((s, r) => s + (Number(r[key]) || 0), 0);
}

function groupBy(records, key) {
  const groups = {};
  for (const r of records) {
    const k = r[key] || "(未填)";
    if (!groups[k]) groups[k] = { key: k, revenue: 0, count: 0 };
    groups[k].revenue += r.amount;
    groups[k].count += 1;
  }
  return Object.values(groups).sort((a, b) => b.revenue - a.revenue);
}

function getStoredValuePool(customerSheet) {
  const values = customerSheet.getDataRange().getValues();
  let total = 0;
  for (let i = 1; i < values.length; i++) total += Number(values[i][8]) || 0;
  return total;
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
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 測試用：Apps Script 編輯器選這支執行，從「執行記錄」看結果 */
function testDoGet() {
  const result = doGet({ parameter: { key: BOSS_KEY, period: "current_month" } });
  Logger.log(result.getContent());
}
