/**
 * 寵美自動化維運 — 流程 3 每日營收報表 + 流程 4 健康監控
 *
 * 為什麼獨立一個專案？
 *   - 跟客戶端 API（pet-grooming-liff、pet-grooming）解耦
 *   - 報表/監控有問題時，客戶端 API 不會被牽連
 *   - 權限只需要：讀檔案 A、寄信、UrlFetchApp（不需要日曆/Drive 寫入）
 *
 * 部署：Apps Script 新專案 → 貼這份 Code.gs
 *      → 專案設定 → 指令碼屬性 設 LINE_TOKEN, BOSS_USER_ID, BOSS_EMAIL, HEALTH_URL
 *      → 觸發條件 設兩個（dailyRevenueReport 每日 20-21 點、healthCheck 每小時）
 *      → 時區設 Asia/Taipei
 */

// ========== ⚠️ 必改區（這份程式碼裡寫的是「設定常數」，不是密碼，可進 git） ==========
const FILE_A_URL = "https://docs.google.com/spreadsheets/d/1jkgtipEu0bsBcGU7yyeBl7_tZzdp5P9Iaezq1e6gq60/edit";
const SHEET_RECORD = "服務紀錄";
const SHOP_NAME = "洗毛這件小事";
// 健康檢查冷卻時間（毫秒）— 同一個故障 2 小時內只警報一次
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
// =================================================================================

// ============================================================
// 流程 3：每日 20:00 自動算當日 + MTD 營收，寄 Email + 推 LINE
// 部署：觸發條件 → 時間驅動 → 日計時器 → 「下午 8 點到 9 點」
// ============================================================
function dailyRevenueReport() {
  const now = new Date();
  const stats = computeRevenueStats(now);

  // 推 LINE 摘要（不論有無服務都推）
  const lineText = buildLineSummary(now, stats);
  pushLine(lineText);

  // 無服務紀錄就只推 LINE 不寄信
  if (stats.todayCount === 0) {
    Logger.log("今日無服務紀錄，僅推 LINE 摘要、不寄 Email");
    return;
  }

  // 寄 HTML Email
  const subject = `[${SHOP_NAME}] ${formatDateLabel(now)} 每日營收報表`;
  const htmlBody = buildEmailHtml(now, stats);
  const email = PropertiesService.getScriptProperties().getProperty("BOSS_EMAIL");
  if (!email) {
    Logger.log("BOSS_EMAIL 未設定，跳過寄信");
    return;
  }
  MailApp.sendEmail({
    to: email,
    subject: subject,
    htmlBody: htmlBody,
  });
  Logger.log("已寄信給 " + email);
}

function computeRevenueStats(now) {
  const sheet = SpreadsheetApp.openByUrl(FILE_A_URL).getSheetByName(SHEET_RECORD);
  if (!sheet) throw new Error("找不到分頁：" + SHEET_RECORD);
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1); // 跳表頭

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(todayStart.getTime() + 86400000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  // 上月同期截止日：對應「今月 1 日 ~ 今天」這段時間長度
  // 處理「今天 3/31，上月對應到 2/31 → 自動 normalize 成 3/3」的問題：
  //   取 min(今月-1 月最後一天, 今天日期)
  const lastMonthLastDay = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  const lastMonthSameDayNum = Math.min(now.getDate(), lastMonthLastDay);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth() - 1, lastMonthSameDayNum);
  lastMonthEnd.setHours(23, 59, 59, 999);

  let todayAmount = 0, todayCount = 0;
  let monthAmount = 0, monthCount = 0;
  let lastMonthMTDAmount = 0, lastMonthMTDCount = 0;
  const todayDetails = [];

  for (const r of rows) {
    const d = r[0];
    if (!(d instanceof Date)) continue; // 跳過格式錯誤
    const amount = Number(r[4]) || 0;

    if (d >= todayStart && d < todayEnd) {
      todayAmount += amount;
      todayCount++;
      todayDetails.push({
        ownerPhone: r[1] || "",
        petName: r[2] || "",
        service: r[3] || "",
        amount: amount,
        payment: r[5] || "",
        staff: r[6] || "",
        remark: r[7] || "",
      });
    }
    if (d >= monthStart && d < todayEnd) {
      monthAmount += amount;
      monthCount++;
    }
    if (d >= lastMonthStart && d <= lastMonthEnd) {
      lastMonthMTDAmount += amount;
      lastMonthMTDCount++;
    }
  }

  const diff = monthAmount - lastMonthMTDAmount;
  const pct = lastMonthMTDAmount === 0 ? null : (diff / lastMonthMTDAmount) * 100;

  return {
    todayAmount, todayCount, monthAmount, monthCount,
    lastMonthMTDAmount, lastMonthMTDCount,
    diff, pct, todayDetails,
  };
}

function buildLineSummary(now, s) {
  const lines = [];
  lines.push(`📊 ${formatDateLabel(now)} 營收報表`);
  if (s.todayCount === 0) {
    lines.push("今日無服務紀錄");
    lines.push(`本月累計：NT$${fmt(s.monthAmount)}（${s.monthCount} 筆）`);
  } else {
    lines.push(`今日：NT$${fmt(s.todayAmount)}（${s.todayCount} 筆）`);
    lines.push(`本月累計：NT$${fmt(s.monthAmount)}`);
  }
  if (s.pct === null) {
    lines.push("vs 上月同期：上月同期無資料");
  } else {
    const arrow = s.diff >= 0 ? "↑" : "↓";
    const sign = s.diff >= 0 ? "+" : "";
    lines.push(`vs 上月同期：${sign}${s.pct.toFixed(1)}% ${arrow}（NT$${fmt(s.lastMonthMTDAmount)}）`);
  }
  return lines.join("\n");
}

function buildEmailHtml(now, s) {
  const detailRows = s.todayDetails.map((d) =>
    `<tr>
      <td>${esc(d.petName)}</td>
      <td>${esc(d.service)}</td>
      <td style="text-align:right">${fmt(d.amount)}</td>
      <td>${esc(d.payment)}</td>
      <td>${esc(d.staff)}</td>
      <td>${esc(d.remark)}</td>
    </tr>`
  ).join("");

  const pctStr = s.pct === null
    ? "（上月同期無資料）"
    : `${s.diff >= 0 ? "+" : ""}${s.pct.toFixed(1)}% ${s.diff >= 0 ? "↑" : "↓"}`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { font-family: "Microsoft JhengHei", sans-serif; color:#222; }
  h1 { color:#8a5a2b; border-bottom:2px solid #c9b99a; padding-bottom:6px; }
  .kpi { display:flex; gap:20px; margin:16px 0; }
  .kpi .card { background:#fff9ec; border:1px solid #f5e6c0; padding:12px 16px; border-radius:6px; min-width:120px; }
  .kpi .card .num { font-size:20pt; font-weight:700; color:#8a5a2b; }
  .kpi .card .lbl { font-size:10pt; color:#666; }
  table.detail { width:100%; border-collapse:collapse; margin-top:16px; }
  table.detail th, table.detail td { border:1px solid #ccc; padding:6px 10px; font-size:11pt; }
  table.detail th { background:#f4f0e6; color:#8a5a2b; }
</style></head>
<body>
  <h1>${esc(SHOP_NAME)} · ${formatDateLabel(now)} 每日營收報表</h1>

  <div class="kpi">
    <div class="card"><div class="lbl">今日金額</div><div class="num">NT$${fmt(s.todayAmount)}</div></div>
    <div class="card"><div class="lbl">今日筆數</div><div class="num">${s.todayCount}</div></div>
    <div class="card"><div class="lbl">本月累計</div><div class="num">NT$${fmt(s.monthAmount)}</div></div>
    <div class="card"><div class="lbl">vs 上月同期 (MTD)</div><div class="num">${pctStr}</div></div>
  </div>

  <p style="color:#666; font-size:10pt;">
    本月累計：${s.monthCount} 筆 / NT$${fmt(s.monthAmount)}　|
    上月同期：${s.lastMonthMTDCount} 筆 / NT$${fmt(s.lastMonthMTDAmount)}
  </p>

  <h2 style="color:#8a5a2b;">今日明細</h2>
  <table class="detail">
    <thead><tr>
      <th>寵物</th><th>服務項目</th><th>金額</th><th>付款方式</th><th>美容師</th><th>備註</th>
    </tr></thead>
    <tbody>${detailRows}</tbody>
  </table>

  <p style="color:#888; font-size:9pt; margin-top:24px;">
    自動產出於 ${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}　|
    Mylittlethings · pet-grooming-ops
  </p>
</body></html>`;
}

// ============================================================
// 流程 4：每小時打健康檢查 URL，異常推 LINE（每個 URL 獨立 2 小時冷卻）
// 部署：觸發條件 → 時間驅動 → 小時計時器 → 「每小時」
//
// HEALTH_URL 設定（ScriptProperties）：支援多個 URL
//   - 多個 URL 用「換行」或「逗號」分隔
//   - 每個 URL 應回傳 JSON 含 ts 欄位
//   範例：
//     HEALTH_URL=
//     https://script.google.com/macros/s/AAA.../exec?health=1
//     https://script.google.com/macros/s/BBB.../exec?health=1
// ============================================================
function healthCheck() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty("HEALTH_URL") || "";
  const urls = raw.split(/[\n,]+/).map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    Logger.log("HEALTH_URL 未設定");
    return;
  }

  for (const url of urls) {
    checkOneUrl_(url, props);
  }
}

function checkOneUrl_(url, props) {
  let ok = false;
  let status = "";
  try {
    const res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
    });
    const code = res.getResponseCode();
    if (code === 200) {
      try {
        const data = JSON.parse(res.getContentText());
        if (data && data.ts) {
          ok = true;
        } else {
          status = "200 但 JSON 無 ts 欄位";
        }
      } catch (parseErr) {
        status = "200 但 JSON 解析失敗";
      }
    } else {
      status = "HTTP " + code;
    }
  } catch (e) {
    status = "逾時或例外：" + String((e && e.message) || e).substring(0, 100);
  }

  // 用 URL 的字母數字尾段做 cooldown key，多個 URL 各自獨立計時
  const cooldownKey = "LAST_ALERT_AT_" + url.replace(/[^A-Za-z0-9]/g, "").slice(-30);
  const label = labelOfUrl_(url);

  if (ok) {
    props.deleteProperty(cooldownKey);
    Logger.log("[" + label + "] OK");
    return;
  }

  // 2 小時冷卻
  const lastAlertAtStr = props.getProperty(cooldownKey);
  const now = Date.now();
  if (lastAlertAtStr) {
    const last = parseInt(lastAlertAtStr, 10);
    if (now - last < ALERT_COOLDOWN_MS) {
      Logger.log("[" + label + "] Cooldown 中，靜默：" + status);
      return;
    }
  }

  const text =
    "⚠️ Apps Script 服務異常\n" +
    "服務：" + label + "\n" +
    "偵測時間：" + new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }) + "\n" +
    "狀態：" + status + "\n" +
    "請至 Google Apps Script 管理部署確認";
  pushLine(text);
  props.setProperty(cooldownKey, String(now));
}

// 從 URL 抽出可讀的 service 標籤（給警報訊息用）
// 因為所有 Apps Script URL 長得幾乎一樣，只能靠中間部署 ID 的前幾碼區分
function labelOfUrl_(url) {
  const m = url.match(/\/macros\/s\/([^/]+)/);
  if (m) return "Apps Script (" + m[1].substring(0, 8) + "...)";
  return url.substring(0, 60);
}

// ============ LINE 推播共用函式（從 ScriptProperties 讀 token） ============
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

// ============ 工具函式 ============
function fmt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateLabel(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${dd}`;
}

// ============================================================
// setupGuideSheet：把「使用教學」內容自動寫入檔案 A 的「使用教學」分頁
// 重複執行 idempotent — 每次都會清空舊內容後重寫（包括最後更新時間）
//
// 在編輯器選 setupGuideSheet → 執行 → 第一次會跳 Sheets 寫入授權
// 之後內容要更新就改 buildGuideRows_() 裡的資料、再執行一次
// ============================================================
function setupGuideSheet() {
  const file = SpreadsheetApp.openByUrl(FILE_A_URL);
  const sheetName = "使用教學";
  let sheet = file.getSheetByName(sheetName);
  if (sheet) {
    // 先解除合併、再清內容 + 格式（順序很重要，clear 不一定清掉 merge）
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
    sheet.clear();
    sheet.setFrozenRows(0);
  } else {
    sheet = file.insertSheet(sheetName);
  }

  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 760);

  const rows = buildGuideRows_();

  // 一次寫入所有內容（比逐行 setValue 快很多）
  const values = rows.map((r) => {
    if (r.kind === "h1" || r.kind === "h2" || r.kind === "sub") return [r.text || "", ""];
    if (r.kind === "blank") return ["", ""];
    if (r.kind === "rule") return ["⚠️ 紅線", r.text || ""];
    return [r.a || "", r.b || ""];
  });
  if (values.length > 0) {
    sheet.getRange(1, 1, values.length, 2).setValues(values);
  }

  // 套樣式（每行各自處理）
  rows.forEach((r, i) => {
    const n = i + 1;
    if (r.kind === "h1") {
      sheet.getRange(n, 1, 1, 2).merge();
      sheet.getRange(n, 1)
        .setBackground("#8a5a2b").setFontColor("#ffffff")
        .setFontWeight("bold").setFontSize(18)
        .setHorizontalAlignment("center").setVerticalAlignment("middle");
      sheet.setRowHeight(n, 46);
    } else if (r.kind === "sub") {
      sheet.getRange(n, 1, 1, 2).merge();
      sheet.getRange(n, 1)
        .setBackground("#fff9ec").setFontColor("#666666")
        .setFontSize(10).setFontStyle("italic")
        .setHorizontalAlignment("center").setVerticalAlignment("middle");
      sheet.setRowHeight(n, 24);
    } else if (r.kind === "h2") {
      sheet.getRange(n, 1, 1, 2).merge();
      sheet.getRange(n, 1)
        .setBackground("#f4f0e6").setFontColor("#8a5a2b")
        .setFontWeight("bold").setFontSize(14)
        .setVerticalAlignment("middle");
      sheet.setRowHeight(n, 34);
    } else if (r.kind === "kv") {
      sheet.getRange(n, 1)
        .setBackground("#fff9ec").setFontColor("#8a5a2b")
        .setFontWeight("bold").setVerticalAlignment("top").setWrap(true);
      sheet.getRange(n, 2)
        .setVerticalAlignment("top").setWrap(true);
    } else if (r.kind === "rule") {
      sheet.getRange(n, 1)
        .setBackground("#ffe4e4").setFontColor("#c0392b")
        .setFontWeight("bold").setVerticalAlignment("top");
      sheet.getRange(n, 2)
        .setBackground("#fff5f5").setFontColor("#a93226")
        .setVerticalAlignment("top").setWrap(true);
    }
    // blank 行不設樣式
  });

  // 凍結最上面的 H1 標題列
  sheet.setFrozenRows(1);

  // 自動調整有 wrap 內容的 row 高度，讓多行文字不被切掉
  sheet.autoResizeRows(2, rows.length - 1);

  Logger.log("「" + sheetName + "」分頁已重建，共 " + rows.length + " 行");
  return rows.length;
}

function buildGuideRows_() {
  const ts = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  return [
    { kind: "h1", text: "🐶 Mylittlethings 使用教學" },
    { kind: "sub", text: "寵物美容店所有自動化工具的「誰該做什麼」一站式說明　·　最後更新 " + ts + "　·　重新生成請執行 setupGuideSheet()" },
    { kind: "blank" },

    // ===== 客戶 =====
    { kind: "h2", text: "🐾 客戶（用 LINE 填表單）" },
    { kind: "kv", a: "第一次來店",
      b: "1️⃣ 加官方帳號好友（店員給 QR）\n2️⃣ 在聊天視窗點豐富選單「填新客戶表單」\n3️⃣ 填寫資料（姓名 / 電話 / 寵物名 / 品種 / 備註 / 服務項目）\n4️⃣ 同意注意事項 + 用手指簽名\n5️⃣ 送出 → 等 5–10 秒收到「✅ 簽約完成」+ PDF 連結" },
    { kind: "rule",
      text: "一定要在 LINE 內開表單（不是 Safari / Chrome 直接打網址）\n簽完名要看清楚再送，送出後不能改\n沒收到 PDF 連結 = 送出失敗，請重新打開填一次（資料不會自動保留）" },
    { kind: "kv", a: "之後每次來店", b: "不用再填，店員會幫你記帳" },
    { kind: "blank" },

    // ===== 老闆 =====
    { kind: "h2", text: "👔 老闆（每天的事）" },
    { kind: "kv", a: "自動會收到的通知",
      b: "📅 16:00 LINE「明日預約清單」\n✅ LIFF 簽約即時 LINE「新簽約完成」+ PDF 連結\n📊 20:00 LINE「營收報表」+ Email 完整明細\n⚠️ 服務掛掉 LINE「Apps Script 異常」（同事故 2 小時內只警報一次）" },
    { kind: "kv", a: "每天主動：建明日預約",
      b: "Google 日曆建事件：\n  • 標題：寵物名 + 服務記號（剪毛加 ✂️ 或「剪」字，例：小白✂️）\n  • 描述欄：客戶手機（格式不限：0905-435-751 / 0905435751 / +886-905-435-751 都會自動辨識）\n  • 店休：標題寫「特休 / 公休 / 休假 / 店休」會自動跳過" },
    { kind: "kv", a: "不定期主動：補客戶資料",
      b: "檔案 A「客戶資料」分頁：\n  • G 欄「重要提醒」（兇 / 心臟病 / 怕剪刀聲；分號分隔）\n  • I 欄「儲值金餘額」\n  • J 欄「最近到店」\n（這 3 欄 LIFF 不會自動寫，靠你手動補）" },
    { kind: "rule",
      text: "LINE 必須加自己的官方帳號為好友（不加 Push 推不到）\n檔案 A 永遠建在老闆帳號，不要建在員工帳號（員工離職你會失去資料）\n「服務紀錄」E 欄（金額）絕對不能放 =SUM()（員工會看到月營收，違反設計）\n想看月營收 → 看老闆儀表板（PWA）或檔案 B，不是檔案 A\n客戶資料 K-O 欄（建立時間 / 來源 / 本次服務 / 本次金額 / LINE_userId）是 LIFF 自動寫的，別動" },
    { kind: "blank" },

    // ===== 員工 =====
    { kind: "h2", text: "👩‍🔧 員工（店內平板用）" },
    { kind: "kv", a: "平板登入",
      b: "只登「店共用帳號」（例：shop-tablet@gmail.com）\n不登老闆帳號\n書籤兩個頁面：員工查詢頁 + 檔案 A 試算表" },
    { kind: "kv", a: "客人來店流程",
      b: "1️⃣ 員工查詢頁 → 輸入主人手機號 → 看客戶 / 寵物 / 重要提醒 / 美容備註 / 儲值金 / 最近到店\n2️⃣ 服務完成 → 切到檔案 A「服務紀錄」分頁 → 加 1 列：\n   日期 ｜ 主人電話 ｜ 寵物名 ｜ 服務項目 ｜ 金額 ｜ 付款方式 ｜ 美容師 ｜ 備註" },
    { kind: "rule",
      text: "服務紀錄要當天填完（晚上 20:00 自動營收報表會用這欄資料）\n金額 E 欄填純數字（800，不是 NT$800、不是 800元）\n「服務紀錄」分頁絕對不能加 SUM 公式（這是禁忌）\n「客戶資料」分頁只能改 G 欄（重要提醒）、H 欄（美容備註），其他欄位不要動" },
    { kind: "kv", a: "客人說來剪過但找不到", b: "可能 LIFF 留錯電話 → 跟老闆反應，老闆來修" },
    { kind: "kv", a: "客人說有用 LIFF 填過表單", b: "客戶資料分頁應該已自動有他了，不用手動建" },
    { kind: "blank" },

    // ===== 工程師：KEY 一覽 =====
    { kind: "h2", text: "🛠️ 維護工程師：主要 KEY 一覽" },
    { kind: "kv", a: "LINE_TOKEN", b: "🔒 密碼｜ScriptProperties（3 個專案各一份：appointment-helper、pet-grooming-liff、pet-grooming-ops）｜不進 git" },
    { kind: "kv", a: "BOSS_USER_ID", b: "🔒 隱私｜同上 3 個專案 ScriptProperties｜不進 git" },
    { kind: "kv", a: "APPT_KEY", b: "🔒 密碼｜appointment-helper 獨有 ScriptProperty（前端密碼登入 + dailyPushTomorrowAppt 都用）｜不進 git" },
    { kind: "kv", a: "BOSS_EMAIL", b: "🔒 隱私｜pet-grooming-ops ScriptProperty（收每日營收報表）｜不進 git" },
    { kind: "kv", a: "BOSS_KEY", b: "🔒 密碼｜老闆儀表板 Apps Script 線上常數（本地檔案是佔位符）｜不進 git" },
    { kind: "kv", a: "HEALTH_URL", b: "公開｜pet-grooming-ops ScriptProperty｜多 URL 用換行 / 逗號分隔（同時監控 LIFF + 預約小幫手）" },
    { kind: "kv", a: "LIFF_ID", b: "🔓 公開｜tools/pet-grooming-liff/index.html｜可進 git" },
    { kind: "kv", a: "PDF_FOLDER_ID", b: "📎 ID｜tools/pet-grooming-liff/Code.gs｜可進 git（不是密碼）" },
    { kind: "kv", a: "FILE_A_URL", b: "📎 ID｜多支 Code.gs（appointment-helper、pet-grooming-liff、pet-grooming-ops）｜可進 git" },
    { kind: "blank" },

    // ===== 工程師：排查表 =====
    { kind: "h2", text: "🛠️ 維護工程師：症狀排查表" },
    { kind: "kv", a: "老闆完全沒收 LINE", b: "1. 還是官方帳號好友嗎？\n2. LINE_TOKEN 過期？→ Console 重發，3 個專案 ScriptProperty 重設" },
    { kind: "kv", a: "簽 LIFF 老闆沒收通知", b: "看「簽約通知 log」分頁有沒有 append。\n沒 append → doPost 改完沒重部署。\n有 append 但 status=error → 看 H 欄 errorMsg" },
    { kind: "kv", a: "16:00 預約沒推", b: "appointment-helper 觸發條件記錄查當天執行。\n失敗 → 看執行記錄。\n沒記錄 → 時區是不是 Asia/Taipei" },
    { kind: "kv", a: "20:00 營收沒推或數字錯", b: "執行 testRevenueStats 看計算過程。\n「服務紀錄」A 欄不是 Date 物件（純文字會被跳過 → 數字偏低）" },
    { kind: "kv", a: "健康監控狂發警報", b: "警報訊息有 service label → 進該專案管理部署看執行記錄" },
    { kind: "kv", a: "LIFF 改完手機看舊版", b: "LINE app 快取問題（不是程式 bug）→ 設定 → 應用程式 → LINE → 儲存空間 → 清除快取（不是清除資料）" },
    { kind: "kv", a: "員工查詢頁查不到客戶", b: "主人電話有 normalize 成 09 開頭 10 碼嗎？客戶資料 A 欄電話格式對嗎？" },
    { kind: "kv", a: "Code.gs 改完沒生效", b: "Web App 必須「管理部署 → 新版本 → 部署」才生效。trigger 即時用新 code，不用部署" },
    { kind: "blank" },

    // ===== 工程師：金規 + 炸雷 =====
    { kind: "h2", text: "🛠️ 維護工程師：兩條金規 + 常見炸雷" },
    { kind: "rule", text: "改 ScriptProperty 不需重部署：所有 trigger 跟 doGet/doPost 下次跑時即時讀新值\n改 Code.gs 必須重部署：右上「部署」→「管理部署作業」→ 鉛筆 → 版本「新版本」→ 部署。URL 不變，前端不用改" },
    { kind: "kv", a: "炸雷 1：LINE_TOKEN 過期", b: "Console 重發 → 3 個專案的 ScriptProperty 都要同步" },
    { kind: "kv", a: "炸雷 2：APPT_KEY 改了", b: "appointment-helper ScriptProperty + 員工/老闆記住的密碼都要更新" },
    { kind: "kv", a: "炸雷 3：檔案 A 換 URL", b: "3 支 Code.gs 的 FILE_A_URL 全改 + 線上重貼 + 重部署" },
    { kind: "kv", a: "炸雷 4：「服務紀錄」改欄位順序", b: "pet-grooming-ops 的 computeRevenueStats 內 r[0]~r[7] 對應要跟著改" },
    { kind: "kv", a: "炸雷 5：LIFF_ID 字元 1/l/I 混淆", b: "永遠 copy-paste，不要靠眼睛校對（踩坑筆記第 168 條）" },
    { kind: "kv", a: "炸雷 6：貼新版 Code.gs 蓋掉密碼", b: "貼之前先檢查本地有沒有佔位符，有就先去 ScriptProperty 設真值再貼" },
    { kind: "blank" },

    // ===== 完整文件 =====
    { kind: "h2", text: "📚 完整文件交叉索引" },
    { kind: "kv", a: "Markdown 詳版", b: "tools/使用教學.md（GDrive 工作桌）" },
    { kind: "kv", a: "進度 + 踩坑筆記", b: "secondbrain/Mylittlethings/工作筆記.md" },
    { kind: "kv", a: "整體架構藍圖", b: "CLAUDE.md（工作桌根目錄）" },
    { kind: "kv", a: "各工具部署指南", b: "tools/<工具>/部署指南.md" },
  ];
}

// ============ 測試函式（在編輯器選函式名 → 執行） ============
function testPushLine() {
  Logger.log("ok=" + pushLine("🧪 [ops] 測試 " + new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })));
}

function testRevenueReport() {
  dailyRevenueReport();
}

function testHealthCheck() {
  healthCheck();
}

function testRevenueStats() {
  const s = computeRevenueStats(new Date());
  Logger.log(JSON.stringify(s, null, 2));
}

function testSetupGuideSheet() {
  Logger.log("rows written = " + setupGuideSheet());
}
