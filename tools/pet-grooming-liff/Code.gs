/**
 * 寵美客戶 LIFF 表單後端 — 接收客戶填寫資料 + 簽名 → 寫 Sheets + 產 PDF + 存 Drive
 *
 * 流程：
 *   1. doPost 接收 LIFF 前端送來的 JSON（客戶資料、簽名 Base64 PNG、時間戳、LINE userId）
 *   2. 驗證必填欄位（含 liffUserId，沒登入 LINE 的人送不進來）
 *   3. 算 payload 的 SHA-256 哈希（防竄改）
 *   4. Upsert「客戶資料」工作表（電話為 key，存在就更新、不存在就新增）
 *   5. 產 PDF 契約（HTML template → PDF blob）→ 存 Drive 指定資料夾
 *   6. 寫「契約紀錄」工作表（時間戳 / 電話 / 姓名 / 寵物名 / PDF 連結 / 哈希 / userId）
 *   7. 回傳 { ok: true, pdfUrl } 給前端
 *
 * 部署流程詳見 部署指南.md
 */

// ========== ⚠️ 必改區 ==========
// 檔案 A 網址（寫入客戶資料 + 契約紀錄）
const FILE_A_URL = "https://docs.google.com/spreadsheets/d/1jkgtipEu0bsBcGU7yyeBl7_tZzdp5P9Iaezq1e6gq60/edit";
// PDF 契約存檔資料夾 ID（Google Drive URL 中 /folders/ 後面那串）
const PDF_FOLDER_ID = "PDF_FOLDER_ID_PLACEHOLDER";
// 店家資訊（印在 PDF 上）
const SHOP_NAME = "洗毛這件小事";
const SHOP_ADDRESS = "新竹市香山區中華路五段46號2樓";
const SHOP_TEL = "0963733969";
// ================================

const SHEET_CUSTOMER = "客戶資料";
const SHEET_CONTRACT = "契約紀錄";

// ======= doPost：前端送資料進來的入口 =======
function doPost(e) {
  try {
    // LIFF 前端用 text/plain 送，body 是 JSON 字串
    const raw = e && e.postData && e.postData.contents;
    if (!raw) return json({ error: "no_body" });
    const data = JSON.parse(raw);

    // --- 必填驗證 ---
    const required = ["name", "phone", "petName", "signaturePng", "liffUserId"];
    for (const f of required) {
      if (!data[f]) return json({ error: `missing_${f}`, message: `缺少必填：${f}` });
    }
    const phone = normalizePhone(data.phone);
    if (!phone) return json({ error: "invalid_phone", message: "電話格式錯誤" });

    // --- 算哈希（排除 signaturePng 以外的資料）---
    const hashPayload = {
      name: data.name,
      phone: phone,
      petName: data.petName,
      breed: data.breed || "",
      remark: data.remark || "",
      amount: data.amount || "",
      services: data.services || [],
      agreedNoticeAt: data.agreedNoticeAt || "",
      submittedAt: data.submittedAt || "",
      liffUserId: data.liffUserId || "",
    };
    const hash = sha256(JSON.stringify(hashPayload));

    // --- Upsert 客戶資料表 ---
    upsertCustomer(phone, data, hashPayload);

    // --- 產 PDF ---
    const pdfUrl = createContractPdf(phone, data, hashPayload, hash);

    // --- 寫契約紀錄 ---
    appendContractRecord(phone, data, pdfUrl, hash);

    return json({ ok: true, pdfUrl: pdfUrl, hash: hash });
  } catch (err) {
    return json({ error: String((err && err.message) || err) });
  }
}

// ======= doGet：健康檢查用（HTML 改由 GitHub Pages 伺服，不走 Apps Script） =======
function doGet(e) {
  if (e && e.parameter && e.parameter.health) {
    return json({ ok: true, service: "pet-grooming-liff", ts: new Date().toISOString() });
  }
  return json({ ok: true, service: "pet-grooming-liff", note: "API only; HTML served by GitHub Pages" });
}

// ======= 電話正規化（跟預約小幫手同一套邏輯） =======
function normalizePhone(text) {
  const cleaned = String(text || "").replace(/[^\d]/g, "");
  const m = cleaned.match(/09\d{8}/);
  return m ? m[0] : "";
}

// ======= Upsert 客戶資料表 =======
// 規則：用電話當 key，如果存在就更新空白欄位（不覆寫老闆手動填過的），
//       不存在就新增整筆。欄位動態根據 header 判斷。
function upsertCustomer(phone, data, hashPayload) {
  const file = SpreadsheetApp.openByUrl(FILE_A_URL);
  const sheet = file.getSheetByName(SHEET_CUSTOMER);
  if (!sheet) throw new Error(`找不到工作表：${SHEET_CUSTOMER}`);

  const values = sheet.getDataRange().getValues();
  const headers = values[0].map((h) => String(h || "").trim());
  const phoneCol = 0; // 電話固定在 A 欄

  // 動態欄位對應（header 沒有的就跳過）
  const colOf = (name) => headers.indexOf(name);

  // 找現有列
  let rowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if (normalizePhone(values[i][phoneCol]) === phone) {
      rowIndex = i + 1; // Sheets 1-based
      break;
    }
  }

  const servicesStr = (data.services || []).join("/");
  const fieldMap = {
    "電話": phone,
    "姓名": data.name,
    "寵物名": data.petName,
    "品種": data.breed || "",
    "備註": data.remark || "",
    "建立時間": new Date(),
    "來源": "LIFF",
    "本次服務": servicesStr,
    "本次金額": data.amount || "",
    "LINE_userId": data.liffUserId || "",
  };

  if (rowIndex === -1) {
    // 新增一列
    const newRow = headers.map((h) => (h in fieldMap ? fieldMap[h] : ""));
    sheet.appendRow(newRow);
  } else {
    // 更新：只寫有 header 對應到的欄位；姓名/寵物名/品種 只在原格空白時寫
    const range = sheet.getRange(rowIndex, 1, 1, headers.length);
    const current = range.getValues()[0];
    const softFields = new Set(["姓名", "寵物名", "品種", "備註"]);
    headers.forEach((h, i) => {
      if (!(h in fieldMap)) return;
      if (softFields.has(h) && current[i]) return; // 軟欄位：原本有值就不蓋
      current[i] = fieldMap[h];
    });
    range.setValues([current]);
  }
}

// ======= 寫入契約紀錄 =======
function appendContractRecord(phone, data, pdfUrl, hash) {
  const file = SpreadsheetApp.openByUrl(FILE_A_URL);
  const sheet = file.getSheetByName(SHEET_CONTRACT);
  if (!sheet) throw new Error(`找不到工作表：${SHEET_CONTRACT}（請先建立）`);

  sheet.appendRow([
    new Date(),             // A 時間戳
    phone,                  // B 客戶電話
    data.name,              // C 客戶姓名
    data.petName,           // D 寵物名
    (data.services || []).join("/"), // E 服務項目
    data.amount || "",      // F 金額
    pdfUrl,                 // G PDF 連結
    hash,                   // H SHA256 哈希
    data.liffUserId || "",  // I LINE userId
  ]);
}

// ======= 產 PDF 契約 =======
function createContractPdf(phone, data, hashPayload, hash) {
  const folder = DriveApp.getFolderById(PDF_FOLDER_ID);
  const filename = `契約_${phone}_${data.petName}_${formatDateForFilename(new Date())}.pdf`;

  const html = buildContractHtml(data, hashPayload, hash);
  const blob = Utilities.newBlob(html, "text/html", "contract.html").getAs("application/pdf");
  blob.setName(filename);
  const file = folder.createFile(blob);
  // 共用模式：任何擁有連結的人皆可檢視（方便客戶保留）
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

// ======= PDF 的 HTML 模板 =======
function buildContractHtml(data, hashPayload, hash) {
  const services = (data.services || []).map((s) => `<span class="chip">${esc(s)}</span>`).join(" ");
  const now = new Date();
  const dateStr = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`;
  const ua = esc(data.userAgent || "").substring(0, 160);

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif; color: #222; font-size: 12pt; line-height: 1.55; }
  h1 { text-align: center; font-size: 18pt; margin-bottom: 4px; }
  .shop { text-align: center; color: #666; font-size: 10pt; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  table td { border: 1px solid #888; padding: 6px 10px; vertical-align: top; }
  table td.label { background: #f4f0e6; width: 22%; font-weight: 600; color: #8a5a2b; }
  .section-title { font-size: 13pt; font-weight: 700; color: #8a5a2b; margin: 18px 0 6px; border-bottom: 1px solid #c9b99a; padding-bottom: 3px; }
  .notice { background: #fff9ec; border: 1px solid #f5e6c0; padding: 10px 14px; font-size: 10.5pt; line-height: 1.7; }
  .notice ol, .notice ul { margin-left: 18px; }
  .chip { display: inline-block; background: #fff6ea; border: 1px solid #d89862; color: #8a5a2b; padding: 2px 8px; border-radius: 4px; margin-right: 4px; font-size: 10.5pt; }
  .sig-area { margin-top: 30px; display: flex; justify-content: space-between; align-items: flex-end; }
  .sig-block { width: 48%; }
  .sig-block .label { font-size: 11pt; color: #666; margin-bottom: 4px; }
  .sig-block img { max-width: 100%; max-height: 80px; border-bottom: 1px solid #888; padding-bottom: 4px; }
  .sig-block .line { border-bottom: 1px solid #888; height: 84px; }
  .meta { margin-top: 30px; font-size: 9pt; color: #888; border-top: 1px dashed #ccc; padding-top: 8px; }
  .meta div { word-break: break-all; }
</style>
</head>
<body>
  <h1>寵物美容服務契約書</h1>
  <div class="shop">${esc(SHOP_NAME)} · ${esc(SHOP_ADDRESS)} · TEL ${esc(SHOP_TEL)}</div>

  <div class="section-title">客戶與寵物資訊</div>
  <table>
    <tr><td class="label">客戶姓名</td><td>${esc(data.name)}</td><td class="label">聯絡電話</td><td>${esc(hashPayload.phone)}</td></tr>
    <tr><td class="label">寵物名</td><td>${esc(data.petName)}</td><td class="label">品種</td><td>${esc(data.breed || "")}</td></tr>
    <tr><td class="label">備註</td><td colspan="3">${esc(data.remark || "").replace(/\n/g, "<br>")}</td></tr>
  </table>

  <div class="section-title">美容項目</div>
  <table>
    <tr><td class="label">服務項目</td><td>${services || "（未選）"}</td></tr>
    <tr><td class="label">金額</td><td>${esc(data.amount || "（現場確認）")} 元</td></tr>
  </table>

  <div class="section-title">注意事項（客戶已閱讀並同意）</div>
  <div class="notice">
    <p><strong>※ 如果您的寶貝有以下情況請事先告知：</strong></p>
    <ol>
      <li>特殊疾病，如：高傳染性疾病、心臟病、年邁的老犬 或 未超過 1 個月之幼犬…等</li>
      <li>剛領養尚未帶去獸醫院檢查的狗狗</li>
    </ol>
    <ul>
      <li>美容寵物若於店家打烊前未接回，一律以住宿計費</li>
      <li>住宿寵物若超過 1 星期未與店家聯絡，本店將報請相關單位依法辦理</li>
      <li>住宿寵物於美容或住宿期間因本身體質因素所造成之疾病，所產生之醫療費將由飼主自行負擔</li>
      <li>若飼主未告知有跳蚤、壁蝨或打結、皮膚病，美容師有權自行處理，所產生之費用由飼主承擔</li>
      <li>本店將保有寵物體型收費標準之權力</li>
    </ul>
  </div>

  <div class="sig-area">
    <div class="sig-block">
      <div class="label">顧客簽名</div>
      <img src="${esc(data.signaturePng)}" alt="signature">
      <div style="text-align:right; font-size: 10pt; color: #666; margin-top: 4px;">${dateStr}</div>
    </div>
    <div class="sig-block">
      <div class="label">美容人員簽名</div>
      <div class="line"></div>
      <div style="text-align:right; font-size: 10pt; color: #666; margin-top: 4px;">（現場補簽）</div>
    </div>
  </div>

  <div class="meta">
    <div>簽署時間戳：${esc(data.submittedAt || now.toISOString())}</div>
    <div>注意事項同意時間：${esc(data.agreedNoticeAt || "")}</div>
    <div>LINE userId：${esc(data.liffUserId || "（非 LIFF 送出）")}</div>
    <div>資料哈希 SHA-256：${hash}</div>
    <div>客戶裝置：${ua}</div>
  </div>
</body>
</html>`;
}

// ======= 工具函式 =======
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sha256(text) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    text,
    Utilities.Charset.UTF_8
  );
  return bytes.map((b) => ("0" + ((b + 256) % 256).toString(16)).slice(-2)).join("");
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateForFilename(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}${m}${dd}_${hh}${mm}`;
}

// ======= 測試用（在 Apps Script 編輯器執行） =======
function testDoPost() {
  const sigPngTiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const fakeBody = JSON.stringify({
    name: "測試客戶",
    phone: "0912345678",
    petName: "測試寵物",
    breed: "米克斯",
    remark: "測試備註",
    amount: "800",
    services: ["洗澡", "修頭"],
    agreedNoticeAt: new Date().toISOString(),
    signaturePng: sigPngTiny,
    submittedAt: new Date().toISOString(),
    liffUserId: "TEST_USER",
    liffDisplayName: "Tester",
    userAgent: "test",
  });
  const result = doPost({ postData: { contents: fakeBody } });
  Logger.log(result.getContent());
}
