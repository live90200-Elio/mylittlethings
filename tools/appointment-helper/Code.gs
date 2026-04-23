/**
 * 預約小幫手 — 抓明天 Google 日曆預約，產生員工清單 + 客戶提醒稿
 *
 * 日曆事件格式約定：
 *   - 標題：寵物名（有「✂️」或「剪」＝剪毛服務；沒有＝洗澡服務）
 *   - 描述欄：客戶手機號（09XXXXXXXX，格式不限，會自動抓 10 碼）
 *   - 排除事件：標題含「特休 / 公休 / 休假 / 店休」
 *
 * 部署流程詳見 部署指南.md
 */

// ========== ⚠️ 必改區 ==========
// 檔案 A 網址（為了反查主人姓名）
const FILE_A_URL = "https://docs.google.com/spreadsheets/d/1jkgtipEu0bsBcGU7yyeBl7_tZzdp5P9Iaezq1e6gq60/edit";
// 老闆自訂密碼（長度 12+，建議 16+）
const APPT_KEY = "change-me-to-random-long-string";
// 想讀「特定日曆」而不是預設日曆時，填日曆名稱（例如 "寵美預約"）；留空＝預設日曆
const CALENDAR_NAME = "";
// ================================

const SHEET_CUSTOMER = "客戶資料";
const CUT_PATTERN = /✂️|✂|剪/;
const HOLIDAY_PATTERN = /特休|公休|休假|店休/;
const WEEKDAYS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    if (!params.key || params.key !== APPT_KEY) {
      return json({ error: "auth_failed", message: "密碼錯誤或未提供" });
    }

    // 目標日期：預設明天；可用 ?date=YYYY-MM-DD 覆寫（測試用）
    const target = params.date
      ? new Date(params.date + "T00:00:00")
      : tomorrowAt0();
    const rangeEnd = new Date(target);
    rangeEnd.setDate(rangeEnd.getDate() + 1);

    const calendar = CALENDAR_NAME
      ? (CalendarApp.getCalendarsByName(CALENDAR_NAME)[0] || null)
      : CalendarApp.getDefaultCalendar();
    if (!calendar) return json({ error: `找不到日曆：${CALENDAR_NAME}` });

    const customerMap = buildCustomerMap();
    const rawEvents = calendar.getEvents(target, rangeEnd);

    const parsed = rawEvents
      .map((ev) => parseEvent(ev, customerMap))
      .filter((x) => x !== null);
    parsed.sort((a, b) => a.startMs - b.startMs);

    const weekdayStr = WEEKDAYS[target.getDay()];
    const dateStr = `${target.getMonth() + 1}/${target.getDate()}`;

    // 「明天 / 今天 / 某日」智慧詞彙
    const dayWord = dayWordFor(target);

    const staffSummary = buildStaffSummary(parsed, dateStr, weekdayStr, dayWord);

    const reminders = parsed
      .filter((p) => p.phone && p.ownerName)
      .map((p) => ({
        phone: p.phone,
        ownerName: p.ownerName,
        petName: p.petName,
        time: p.timeLabel,
        service: p.service,
        isHaircut: p.isHaircut,
        message: buildReminderMessage(p, dateStr, weekdayStr, dayWord),
      }));

    const missingPhone = parsed
      .filter((p) => !p.phone || !p.ownerName)
      .map((p) => ({
        petName: p.petName,
        time: p.timeLabel,
        service: p.service,
        isHaircut: p.isHaircut,
        reason: !p.phone ? "描述欄無電話" : "電話不在客戶資料",
        phone: p.phone,
      }));

    return json({
      date: formatISODate(target),
      dateLabel: dateStr,
      weekday: weekdayStr,
      dayWord: dayWord,
      totalCount: parsed.length,
      staffSummary: staffSummary,
      reminders: reminders,
      missingPhone: missingPhone,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json({ error: String((err && err.message) || err) });
  }
}

function tomorrowAt0() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayWordFor(target) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const diff = Math.round((target - todayStart) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "後天";
  return `${target.getMonth() + 1}/${target.getDate()}`;
}

function parseEvent(ev, customerMap) {
  const title = ev.getTitle() || "";
  if (HOLIDAY_PATTERN.test(title)) return null;

  const start = ev.getStartTime();
  const isHaircut = CUT_PATTERN.test(title);
  const service = isHaircut ? "剪毛" : "洗澡";
  // 去掉標題裡的 ✂️/剪 字樣，留下乾淨寵物名
  const petName = title.replace(/✂️|✂|剪/g, "").trim() || "(無寵物名)";

  const description = ev.getDescription() || "";
  const phone = extractPhone(description);
  const ownerName = phone ? (customerMap[phone] || "") : "";

  return {
    startMs: start.getTime(),
    timeLabel: formatChineseTime(start),
    petName: petName,
    service: service,
    isHaircut: isHaircut,
    phone: phone,
    ownerName: ownerName,
  };
}

function extractPhone(text) {
  const cleaned = String(text || "").replace(/[^\d]/g, "");
  const m = cleaned.match(/09\d{8}/);
  return m ? m[0] : "";
}

function formatChineseTime(d) {
  let h = d.getHours();
  const m = d.getMinutes();
  const period = h < 12 ? "上午" : "下午";
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  const mm = String(m).padStart(2, "0");
  return `${period} ${h}:${mm}`;
}

function formatISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function buildStaffSummary(events, dateStr, weekdayStr, dayWord) {
  if (events.length === 0) {
    return `📅 ${dayWord} ${dateStr} (${weekdayStr}) 無預約`;
  }
  const lines = events.map((p) => {
    const cut = p.isHaircut ? " ✂️" : "";
    return `${p.timeLabel}　${p.petName}${cut}（${p.service}）`;
  });
  return `📅 ${dayWord} ${dateStr} (${weekdayStr}) 預約 ${events.length} 件\n\n${lines.join("\n")}`;
}

function buildReminderMessage(p, dateStr, weekdayStr, dayWord) {
  const cutIcon = p.isHaircut ? " ✂️" : "";
  return `【${p.ownerName} 您好】\n提醒您${dayWord} ${dateStr} (${weekdayStr}) ${p.timeLabel}\n帶 ${p.petName} 來${p.service}${cutIcon}\n\n如有事取消，請事先提醒，祝您順心！`;
}

function buildCustomerMap() {
  const file = SpreadsheetApp.openByUrl(FILE_A_URL);
  const sheet = file.getSheetByName(SHEET_CUSTOMER);
  if (!sheet) throw new Error(`找不到工作表：${SHEET_CUSTOMER}`);
  const values = sheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const phone = String(values[i][0] || "").trim();
    const name = String(values[i][1] || "").trim();
    if (phone) map[phone] = name;
  }
  return map;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 測試用：Apps Script 編輯器選這支執行，從「執行記錄」看結果 */
function testDoGet() {
  const result = doGet({ parameter: { key: APPT_KEY } });
  Logger.log(result.getContent());
}
