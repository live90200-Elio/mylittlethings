/**
 * 寵美客戶 LIFF 表單後端 — v2 草稿（2026-06-15）
 * 升級：官方「犬貓美容定型化契約」22條 + 基本資料表 + 設定驅動 + 一人簽一次
 *
 * 與 v1 的差異（向下相容，新欄位全選填）：
 *   - doGet 新增 ?check=<userId>（一人簽一次查詢）、?config=1、?terms=1
 *   - getContractConfig()：讀檔案A「契約設定」分頁，缺值走法規安全預設
 *   - buildContractTermsHtml(config)：官方22條，店家政策由設定帶入（前端/PDF 同源）
 *   - buildContractHtml() 改成 官方版（基本資料表 + 22條 + 雙方簽名 + SHA）
 *   - doPost 收基本資料表新欄位（晶片/緊急聯絡人/個性/病史/指定獸醫…），全選填
 *
 * ⚠️ 部署前必檢查（CLAUDE.md）：先比對線上版本，確認沒誤改再新增版本部署。
 * 部署 OK 後：把本檔覆蓋 Code.gs，並 snapshot 回 mylittlethings（佔位符版）。
 */

// ========== ⚠️ 必改區 ==========
const FILE_A_URL = "https://docs.google.com/spreadsheets/d/PASTE_FILE_A_SHEET_ID/edit";
const PDF_FOLDER_ID = "1ECKKS3qsMwK1Vu-lmZ0PnMAcQW7nRSZx";
// 店家資訊預設（沒設定分頁時用；建議改成填「契約設定」分頁）
const SHOP_NAME = "洗毛這件小事";
const SHOP_ADDRESS = "新竹市香山區中華路五段46號2樓";
const SHOP_TEL = "0963733969";
// 第20條 管轄法院預設（留空走法規安全預設「消費者所在地之地方法院」；填了就用填的）
const SHOP_COURT = "新竹地方法院";
// ================================

const SHEET_CUSTOMER = "客戶資料";
const SHEET_CONTRACT = "契約紀錄";
const SHEET_NOTIFY_LOG = "簽約通知 log";
const SHEET_CONFIG = "契約設定";

// ======= doGet：健康檢查 / 一人簽一次查詢 / 設定 / 契約全文 =======
function doGet(e) {
  const p = (e && e.parameter) || {};

  if (p.health) {
    return json({ ok: true, service: "pet-grooming-liff", ts: new Date().toISOString() });
  }

  // 一人簽一次：前端進頁先查 userId 有沒有簽過
  if (p.check) {
    return json(findExistingContract(String(p.check), p.checkPhone ? String(p.checkPhone) : ""));
  }

  // 給前端：店家政策設定
  if (p.config) {
    return json({ ok: true, config: getContractConfig() });
  }

  // 給前端：填好政策的契約全文（顯示用，與 PDF 同源）
  if (p.terms) {
    return json({ ok: true, termsHtml: buildContractTermsHtml(getContractConfig()) });
  }

  return json({ ok: true, service: "pet-grooming-liff", note: "API only; HTML served by GitHub Pages" });
}

// ======= 一人簽一次：用 userId（優先）或電話查「契約紀錄」最近一筆 =======
function findExistingContract(userId, phoneRaw) {
  try {
    const phone = normalizePhone(phoneRaw);
    const file = SpreadsheetApp.openByUrl(FILE_A_URL);
    const sheet = file.getSheetByName(SHEET_CONTRACT);
    if (!sheet) return { ok: true, signed: false };
    const vals = sheet.getDataRange().getValues();
    // 欄位：A時間戳 B電話 C姓名 D寵物名 E服務 F金額 G PDF H哈希 I userId
    let found = null;
    for (let i = 1; i < vals.length; i++) {
      const rowUid = String(vals[i][8] || "").trim();
      const rowPhone = normalizePhone(vals[i][1]);
      const matchUid = userId && rowUid && rowUid === userId;
      const matchPhone = phone && rowPhone && rowPhone === phone;
      if (matchUid || matchPhone) found = vals[i]; // 取最後一筆（最近）
    }
    if (!found) return { ok: true, signed: false };
    const ts = found[0];
    const signedAt = (ts instanceof Date)
      ? Utilities.formatDate(ts, "Asia/Taipei", "yyyy/MM/dd")
      : String(ts);
    return {
      ok: true, signed: true,
      signedAt: signedAt,
      name: String(found[2] || ""),
      petName: String(found[3] || ""),
      pdfUrl: String(found[6] || ""),
    };
  } catch (err) {
    Logger.log("[findExistingContract] " + err);
    return { ok: true, signed: false, warn: String(err) };
  }
}

// ======= 讀「契約設定」分頁（缺值走安全預設）=======
function getContractConfig() {
  const def = {
    shop_name: SHOP_NAME, shop_rep: "", shop_address: SHOP_ADDRESS, shop_tel: SHOP_TEL,
    business_hours: "",
    cancel_fee_mode: "none", cancel_fee_percent: "",
    overtime_fee_mode: "none", overtime_fee_amount: "",
    pickup_time: "",
    prepay_guarantee_mode: "none", prepay_guarantee_detail: "",
    court: "",
    vet_default_name: "", vet_default_tel: "", vet_default_addr: "",
  };
  try {
    const file = SpreadsheetApp.openByUrl(FILE_A_URL);
    const sheet = file.getSheetByName(SHEET_CONFIG);
    if (sheet) {
      const vals = sheet.getDataRange().getValues();
      for (let i = 0; i < vals.length; i++) {
        const k = String(vals[i][0] || "").trim();
        const v = String(vals[i][1] || "").trim();
        if (k && v && (k in def)) def[k] = v;
      }
    }
  } catch (e) {
    Logger.log("[getContractConfig] " + e);
  }
  return def;
}

// ======= 政策文字（設定 → 人話）=======
// 手續費/逾時費 留空＝「依店家規定收取」（店家政策，非法規安全預設）；
// 履約保障/管轄/獸醫 留空仍走法規安全預設。要寫明確金額請填「契約設定」分頁（fixed100/percent/hourly）。
function cancelFeeText(c) {
  if (c.cancel_fee_mode === "fixed100") return "定額新臺幣100元";
  if (c.cancel_fee_mode === "percent") {
    let p = parseFloat(c.cancel_fee_percent || "0"); if (!(p > 0)) p = 0;
    if (p > 5) p = 5; // 範本第8條上限
    return "本契約總費用 " + p + "%（最高不逾新臺幣1,000元）";
  }
  return "依店家規定收取";
}
function overtimeFeeText(c) {
  if (c.overtime_fee_mode === "hourly") {
    const a = c.overtime_fee_amount || "○";
    return "每小時新臺幣" + a + "元（未滿30分不收，逾30分起算）";
  }
  return "依店家規定收取";
}
function guaranteeText(c) {
  if (c.prepay_guarantee_mode === "trust") return "信託專戶：" + (c.prepay_guarantee_detail || "（依信託法規交付銀行專戶管理）");
  if (c.prepay_guarantee_mode === "alliance") return "聯合連帶保證協定：" + (c.prepay_guarantee_detail || "");
  return "預收費用累計未消費金額在新臺幣1萬元以下，依範本第15條得免提供";
}
function courtText(c) { return c.court || SHOP_COURT || "消費者所在地之地方法院"; }
function vetDefaultText(c) {
  if (c.vet_default_name) {
    return esc(c.vet_default_name) + (c.vet_default_tel ? "（" + esc(c.vet_default_tel) + "）" : "") + (c.vet_default_addr ? " " + esc(c.vet_default_addr) : "");
  }
  return "飼主未指定時，由本店就近送往適當之獸醫診療機構";
}

// ======= 官方契約全文（22條，店家政策由設定帶入）=======
// 前端 ?terms=1 與 PDF 共用，保證顯示與簽署內容一致。
function buildContractTermsHtml(c) {
  const shop = esc(c.shop_name || SHOP_NAME);
  return `
  <div class="policy">
    <div class="policy-h">本店（乙方）政策摘要</div>
    <table class="pol">
      <tr><td>解約手續費（第8條）</td><td>${cancelFeeText(c)}</td></tr>
      <tr><td>逾時接回費（第12條）</td><td>${overtimeFeeText(c)}</td></tr>
      <tr><td>預收履約保障（第15條）</td><td>${guaranteeText(c)}</td></tr>
      <tr><td>管轄法院（第20條）</td><td>${esc(courtText(c))}</td></tr>
      <tr><td>本店指定獸醫（第6條）</td><td>${vetDefaultText(c)}</td></tr>
      ${c.business_hours ? `<tr><td>營業時間</td><td>${esc(c.business_hours)}</td></tr>` : ""}
    </table>
  </div>
  <div class="terms-body">
    <p class="t-note">簽約注意事項：本契約審閱期不得少於1日；但單次或必要時得給予即時或合理之審閱期間。乙方應於簽約前提供「簽約前詢問事項及基本資料表」由雙方共同填妥，並逐條說明使甲方充分瞭解權利義務。</p>
    <p><b>第1條（契約目的與範圍）</b>犬、貓美容服務，指提供犬、貓外表部位清洗或清潔、吹乾梳毛、毛髮修剪及造型設計等美容服務；不得涉及動物醫療行為及宣稱醫療效能。</p>
    <p><b>第2條（資訊揭露義務）</b>乙方應將本契約公告於營業場所明顯處；有網站或社群媒體者並應於網頁明顯處公告。</p>
    <p><b>第3條（相關資料）</b>應記載寵物晶片或可辨識資訊、甲方姓名/地址/電話/緊急聯絡人及其電話/緊急就醫指定獸醫，及乙方名稱/代表人/營業地址/營業時間/電話/未指定時送交之獸醫場所（詳如基本資料表）。</p>
    <p><b>第4條（服務內容之說明及確認）</b>乙方應於訂約前充分說明美容項目、期間、次數、有無指定服務人員、費用及支付方式；服務內容紀錄經甲方確認後提供正本；收費應開立憑證。</p>
    <p><b>第5條（乙方詢問及照護義務）</b>實施前應詢問犬貓個性、攻擊性、疾病、病史並檢查現況；甲方應誠實告知。實施期間應提供安全、乾淨、通風、適當遮蔽、照明及溫度之環境並妥善照顧。</p>
    <p><b>第6條（異常或死亡之處理）</b>美容期間發現異常應立即妥善處理並通知甲方或緊急聯絡人；有緊急就醫必要時優先送甲方指定獸醫，未指定則就近送適當獸醫（本店指定：${vetDefaultText(c)}）。死亡時應即通知甲方、妥善保存遺體並向動保主管機關報備。<b>可歸責於乙方者，乙方負損害賠償及動保法相關責任。</b></p>
    <p><b>第7條（繳款方式）</b>甲方繳款方式：現金／信用卡／其他（詳基本資料表）。</p>
    <p><b>第8條（實施前任意解除之退費）</b>實施前甲方得隨時解除，乙方於解約後3日內退還已收費用扣除手續費。本店手續費：<b>${cancelFeeText(c)}</b>。</p>
    <p><b>第9條（實施後任意終止之退費）</b>實施後甲方得隨時終止（單次服務不適用），乙方於終止後3日內退還已收費用扣除已接受服務費用及手續費。</p>
    <p><b>第10條（可歸責於乙方之解除或終止）</b>乙方轉委他人履行、變更服務地點或變更指定服務人員者，甲方得解除或終止，乙方3日內退費，甲方另受損害並應賠償。</p>
    <p><b>第11條（不可歸責雙方之解除或終止）</b>因不可抗力，或犬貓死亡、疾病、健康不佳、抗拒服務致難以繼續者，乙方依第8/9條退費但不得扣手續費。</p>
    <p><b>第12條（逾時接回之處理）</b>甲方應於${c.pickup_time ? esc(c.pickup_time) : "雙方約定時間"}前接回。本店逾時費：<b>${overtimeFeeText(c)}</b>。超過營業時間未接回，乙方仍應善盡照顧並得依範本收取違約費（每日最高不逾該次服務費3倍）；逾3日未接回通知動保機關依法處理。</p>
    <p><b>第13條（不可歸責於甲方未接回之處理）</b>因不可抗力致甲方無法準時接回，乙方應安置犬貓並得請求核實之必要費用；安置期間就醫或死亡依第6條辦理。</p>
    <p><b>第14條（費用明確性）</b>總費用（商品材料費、服務費、指定服務人員費）應明列，未明列者不得收取；因繳費獲贈商品/服務（價值≤總費用20%）解約時不得請求返還或扣抵。</p>
    <p><b>第15條（預收費用之履約保障）</b>乙方應就預收費用50%額度提供履約保障（期限1個月內、按月收費或預收累計未消費金額在1萬元以下者得免）。本店方式：<b>${guaranteeText(c)}</b>。</p>
    <p><b>第16條（個人資料保護）</b>乙方因本契約知悉甲方個資應保密並依個資法辦理，非經書面同意不得對外揭露或為目的外利用，契約消滅後亦同。</p>
    <p><b>第17條（違約賠償）</b>因可歸責於一方之事由違約致他方受損，應負損害賠償責任。</p>
    <p><b>第18條（履行輔助人）</b>經甲方同意轉委他業者履行者，該受託業者視為乙方之代理人或使用人。</p>
    <p><b>第19條（申訴處理）</b>甲方不滿意時乙方應指派專人受理；爭議應儘量協商；甲方申請調解時乙方應配合。</p>
    <p><b>第20條（管轄法院）</b>因本契約涉訟，雙方同意以 <b>${esc(courtText(c))}</b> 為第一審管轄法院，但不排除消保法第47條或民訴法第436-9條小額訴訟管轄之適用。</p>
    <p><b>第21條（契約及附件效力）</b>本契約自簽約日起生效，雙方各執一份；廣告及相關附件視為契約之一部分。</p>
    <p><b>第22條（其他約定事項）</b>本電子契約由甲方於 ${shop} 客戶端 LINE 完成線上閱讀、勾選同意及電子簽名，雙方同意其與書面契約具同等效力。</p>
  </div>`;
}

// ======= doPost：前端送資料進來的入口 =======
function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw) return json({ error: "no_body" });
    const data = JSON.parse(raw);

    // --- 必填驗證（基本資料表其餘欄位全選填）---
    const required = ["name", "phone", "petName", "signaturePng", "liffUserId"];
    for (const f of required) {
      if (!data[f]) return json({ error: `missing_${f}`, message: `缺少必填：${f}` });
    }
    const phone = normalizePhone(data.phone);
    if (!phone) return json({ error: "invalid_phone", message: "電話格式錯誤" });

    // --- 算哈希（含基本資料表欄位，排除 signaturePng）---
    const hashPayload = {
      name: data.name, phone: phone, petName: data.petName,
      breed: data.breed || "", petAge: data.petAge || "", petGender: data.petGender || "",
      petSpecies: data.petSpecies || "", petNeuter: data.petNeuter || "", chipNo: data.chipNo || "",
      ownerAddress: data.ownerAddress || "", ownerIsSelf: data.ownerIsSelf || "", ownerRelation: data.ownerRelation || "",
      emergencyName: data.emergencyName || "", emergencyPhone: data.emergencyPhone || "",
      personality: data.personality || [], appearance: data.appearance || "", parasite: data.parasite || "",
      medicalHistory: data.medicalHistory || [],
      vetDesignatedBy: data.vetDesignatedBy || "", vetName: data.vetName || "", vetTel: data.vetTel || "", vetAddr: data.vetAddr || "",
      payMethod: data.payMethod || "", remark: data.remark || "",
      amount: data.amount || "", services: data.services || [],
      agreedAt: data.agreedAt || data.agreedNoticeAt || "",
      submittedAt: data.submittedAt || "", liffUserId: data.liffUserId || "",
    };
    const hash = sha256(JSON.stringify(hashPayload));

    upsertCustomer(phone, data, hashPayload);
    const pdfUrl = createContractPdf(phone, data, hashPayload, hash);
    appendContractRecord(phone, data, pdfUrl, hash);

    try { notifyBossNewContract(data, phone, pdfUrl); }
    catch (notifyErr) { Logger.log("[notifyBoss] " + String(notifyErr)); }

    return json({ ok: true, pdfUrl: pdfUrl, hash: hash });
  } catch (err) {
    return json({ error: String((err && err.message) || err) });
  }
}

// ======= 電話正規化 =======
function normalizePhone(text) {
  const cleaned = String(text || "").replace(/[^\d]/g, "");
  const m = cleaned.match(/09\d{8}/);
  return m ? m[0] : "";
}

// ======= Upsert 客戶資料表（沿用 v1，多帶幾個軟欄位）=======
function upsertCustomer(phone, data, hashPayload) {
  const file = SpreadsheetApp.openByUrl(FILE_A_URL);
  const sheet = file.getSheetByName(SHEET_CUSTOMER);
  if (!sheet) throw new Error(`找不到工作表：${SHEET_CUSTOMER}`);

  const values = sheet.getDataRange().getValues();
  const headers = values[0].map((h) => String(h || "").trim());
  const phoneCol = 0;

  let rowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if (normalizePhone(values[i][phoneCol]) === phone) { rowIndex = i + 1; break; }
  }

  const servicesStr = (data.services || []).join("/");
  const petName = String(data.petName || "").trim();
  const petBreed = data.breed || "";
  const petAge = data.petAge || "";
  const petGender = data.petGender || "";

  const baseMap = {
    "電話": phone,
    "姓名": data.name,
    "通訊地址": data.ownerAddress || "",
    "緊急聯絡人": data.emergencyName || "",
    "緊急聯絡人電話": data.emergencyPhone || "",
    "美容備註": data.remark || "",
    "建立時間": new Date(),
    "來源": "LIFF",
    "本次服務": servicesStr,
    "本次金額": data.amount || "",
    "每次金額": data.amount || "",
    "LINE_userId": data.liffUserId || "",
  };

  function pickPetSlot(currentRowOrNull) {
    if (!currentRowOrNull) return 1;
    const idx1 = headers.indexOf("寵物1名");
    const idx2 = headers.indexOf("寵物2名");
    const name1 = idx1 >= 0 ? String(currentRowOrNull[idx1] || "").trim() : "";
    const name2 = idx2 >= 0 ? String(currentRowOrNull[idx2] || "").trim() : "";
    if (petName && name1 && petName === name1) return 1;
    if (petName && name2 && petName === name2) return 2;
    if (!name1) return 1;
    if (idx2 >= 0 && !name2) return 2;
    return 0;
  }
  function buildPetFields(slot) {
    if (slot === 1) return { "寵物1名": petName, "寵物1品種": petBreed, "寵物1年齡": petAge, "寵物1性別": petGender, "寵物1晶片": data.chipNo || "" };
    if (slot === 2) return { "寵物2名": petName, "寵物2品種": petBreed, "寵物2年齡": petAge, "寵物2性別": petGender, "寵物2晶片": data.chipNo || "" };
    return {};
  }

  if (rowIndex === -1) {
    const fieldMap = Object.assign({}, baseMap, buildPetFields(1));
    const newRow = headers.map((h) => (h in fieldMap ? fieldMap[h] : ""));
    sheet.appendRow(newRow);
    rowIndex = sheet.getLastRow();
  } else {
    const range = sheet.getRange(rowIndex, 1, 1, headers.length);
    const current = range.getValues()[0];
    const slot = pickPetSlot(current);
    const petFields = buildPetFields(slot);
    const fieldMap = Object.assign({}, baseMap, petFields);

    const softFields = new Set([
      "姓名", "通訊地址", "緊急聯絡人", "緊急聯絡人電話",
      "寵物1名", "寵物1品種", "寵物1年齡", "寵物1性別", "寵物1晶片",
      "寵物2名", "寵物2品種", "寵物2年齡", "寵物2性別", "寵物2晶片",
      "美容備註",
    ]);

    if (slot === 0) {
      const remarkIdx = headers.indexOf("美容備註");
      if (remarkIdx >= 0) {
        const overflowLine = `[新寵物] ${petName}/${petBreed}/${petAge}/${petGender}（${new Date().toLocaleDateString("zh-TW")}）`;
        const old = String(current[remarkIdx] || "");
        current[remarkIdx] = old ? (old + "\n" + overflowLine) : overflowLine;
      }
    }

    headers.forEach((h, i) => {
      if (!(h in fieldMap)) return;
      if (softFields.has(h) && current[i]) return;
      if (slot === 0 && h === "美容備註") return;
      current[i] = fieldMap[h];
    });
    range.setValues([current]);
  }

  const phoneHeaderIdx = headers.indexOf("電話");
  if (phoneHeaderIdx >= 0 && rowIndex > 0) {
    sheet.getRange(rowIndex, phoneHeaderIdx + 1).setNumberFormat("@").setValue(phone);
  }
}

// ======= 寫入契約紀錄（沿用 v1 欄位，一人簽一次靠 I 欄 userId）=======
function appendContractRecord(phone, data, pdfUrl, hash) {
  const file = SpreadsheetApp.openByUrl(FILE_A_URL);
  const sheet = file.getSheetByName(SHEET_CONTRACT);
  if (!sheet) throw new Error(`找不到工作表：${SHEET_CONTRACT}（請先建立）`);
  sheet.appendRow([
    new Date(), phone, data.name, data.petName,
    (data.services || []).join("/"), data.amount || "",
    pdfUrl, hash, data.liffUserId || "",
  ]);
  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 2).setNumberFormat("@").setValue(phone);
}

// ======= 產 PDF 契約 =======
function createContractPdf(phone, data, hashPayload, hash) {
  const folder = DriveApp.getFolderById(PDF_FOLDER_ID);
  // 🔀 分流：contractType="official"（新契約頁送）→ 官方定型化契約；
  //         其餘（含舊「寵美預約填單」沒帶旗標）→ 舊簡易版，維持原行為不變。
  const isOfficial = (data.contractType === "official");
  const filename = (isOfficial ? "定型化契約_" : "契約_") + `${phone}_${data.petName}_${formatDateForFilename(new Date())}.pdf`;
  const html = isOfficial ? buildOfficialContractHtml(data, hashPayload, hash) : buildLegacyContractHtml(data, hashPayload, hash);
  const blob = Utilities.newBlob(html, "text/html", "contract.html").getAs("application/pdf");
  blob.setName(filename);
  const file = folder.createFile(blob);
  // ⚠️ 含個資+簽名，憑連結即可檢視。沿用 v1；之後可改更嚴格權限。
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

// ======= PDF 模板 A：官方定型化契約（基本資料表 + 22條 + 雙方簽名）=======
function buildOfficialContractHtml(data, hashPayload, hash) {
  const c = getContractConfig();
  const now = new Date();
  const dateStr = `中華民國 ${now.getFullYear() - 1911} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`;
  const ua = esc(data.userAgent || "").substring(0, 160);

  const services = (data.services || []).map((s) => esc(s)).join("、") || "（未選）";
  const personality = (data.personality || []).map((s) => esc(s)).join("、") || "—";
  const medical = (data.medicalHistory || []).map((s) => esc(s)).join("、") || "無";
  const designatedVet = (data.vetName || data.vetTel || data.vetAddr)
    ? `${esc(data.vetDesignatedBy || "甲方")}指定：${esc(data.vetName || "")} ${esc(data.vetTel || "")} ${esc(data.vetAddr || "")}`
    : `（未指定，依第6條由本店就近送往適當獸醫）`;

  return `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="UTF-8"><style>
  @page { size: A4; margin: 16mm; }
  body { font-family: "Noto Sans CJK TC","Microsoft JhengHei",sans-serif; color:#222; font-size:10.5pt; line-height:1.5; }
  h1 { text-align:center; font-size:16pt; margin:0 0 2px; }
  .shop { text-align:center; color:#555; font-size:9pt; margin-bottom:12px; }
  .section-title { font-size:11pt; font-weight:700; color:#8a5a2b; margin:14px 0 5px; border-bottom:1px solid #c9b99a; padding-bottom:2px; }
  table { width:100%; border-collapse:collapse; margin-bottom:8px; }
  table td { border:1px solid #999; padding:4px 7px; vertical-align:top; }
  td.label { background:#f4f0e6; width:20%; font-weight:600; color:#6e4620; white-space:nowrap; }
  .policy-h { font-weight:700; color:#8a5a2b; margin-bottom:4px; }
  table.pol td { border:1px solid #c9b99a; }
  table.pol td:first-child { background:#faf6ee; width:38%; }
  .terms-body { font-size:9pt; line-height:1.45; }
  .terms-body p { margin:3px 0; }
  .t-note { background:#fff9ec; border:1px solid #f5e6c0; padding:6px 9px; }
  .sig-area { margin-top:22px; display:flex; justify-content:space-between; align-items:flex-end; }
  .sig-block { width:48%; }
  .sig-block .lb { font-size:10pt; color:#555; margin-bottom:3px; }
  .sig-block img { max-width:100%; max-height:72px; border-bottom:1px solid #888; }
  .sig-block .line { border-bottom:1px solid #888; height:74px; }
  .meta { margin-top:18px; font-size:8pt; color:#888; border-top:1px dashed #ccc; padding-top:6px; }
  .meta div { word-break:break-all; }
</style></head><body>
  <h1>犬、貓美容服務定型化契約書</h1>
  <div class="shop">${esc(c.shop_name || SHOP_NAME)}　${esc(c.shop_address || SHOP_ADDRESS)}　TEL ${esc(c.shop_tel || SHOP_TEL)}${c.shop_rep ? "　代表人：" + esc(c.shop_rep) : ""}</div>

  <div class="section-title">一、簽約前詢問事項及基本資料表</div>
  <table>
    <tr><td class="label">飼主姓名</td><td>${esc(data.name)}</td><td class="label">聯絡電話</td><td>${esc(hashPayload.phone)}</td></tr>
    <tr><td class="label">通訊地址</td><td colspan="3">${esc(data.ownerAddress || "")}</td></tr>
    <tr><td class="label">是否飼主本人</td><td>${esc(data.ownerIsSelf || "")}${data.ownerRelation ? "（關係：" + esc(data.ownerRelation) + "）" : ""}</td><td class="label">緊急聯絡人</td><td>${esc(data.emergencyName || "")} ${esc(data.emergencyPhone || "")}</td></tr>
    <tr><td class="label">寵物名</td><td>${esc(data.petName)}</td><td class="label">犬／貓・品種</td><td>${esc(data.petSpecies || "")} ${esc(data.breed || "")}</td></tr>
    <tr><td class="label">年齡／性別</td><td>${esc(data.petAge || "")} ${esc(data.petGender || "")} ${esc(data.petNeuter || "")}</td><td class="label">晶片號碼</td><td>${esc(data.chipNo || "")}</td></tr>
    <tr><td class="label">個性傾向</td><td colspan="3">${personality}</td></tr>
    <tr><td class="label">外觀／外寄生蟲</td><td>${esc(data.appearance || "—")} ${esc(data.parasite || "")}</td><td class="label">病史</td><td>${medical}</td></tr>
    <tr><td class="label">服務項目</td><td>${services}</td><td class="label">金額</td><td>${esc(data.amount || "（現場確認）")} 元</td></tr>
    <tr><td class="label">支付方式</td><td>${esc(data.payMethod || "")}</td><td class="label">緊急就醫指定獸醫</td><td>${designatedVet}</td></tr>
  </table>

  <div class="section-title">二、定型化契約條款</div>
  ${buildContractTermsHtml(c)}

  <div class="sig-area">
    <div class="sig-block">
      <div class="lb">甲方（飼主）簽名</div>
      <img src="${esc(data.signaturePng)}" alt="signature">
      <div style="text-align:right;font-size:9pt;color:#555;margin-top:3px;">${dateStr}</div>
    </div>
    <div class="sig-block">
      <div class="lb">乙方（${esc(c.shop_name || SHOP_NAME)}）簽章</div>
      <div class="line"></div>
      <div style="text-align:right;font-size:9pt;color:#555;margin-top:3px;">${c.shop_rep ? esc(c.shop_rep) : "（現場補簽）"}</div>
    </div>
  </div>

  <div class="meta">
    <div>簽署時間戳：${esc(data.submittedAt || now.toISOString())}　同意時間：${esc(data.agreedAt || data.agreedNoticeAt || "")}</div>
    <div>LINE userId：${esc(data.liffUserId || "（非 LIFF 送出）")}</div>
    <div>資料哈希 SHA-256：${hash}</div>
    <div>客戶裝置：${ua}</div>
  </div>
</body></html>`;
}

// ======= PDF 模板 B：舊簡易版（寵物美容服務契約書）=======
// 舊「寵美預約填單」沿用此版，行為與升級前完全一致（沒帶 contractType 旗標就走這）。
function buildLegacyContractHtml(data, hashPayload, hash) {
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
    <tr><td class="label">年齡</td><td>${esc(data.petAge || "")}</td><td class="label">性別</td><td>${esc(data.petGender || "")}</td></tr>
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
    <div>注意事項同意時間：${esc(data.agreedNoticeAt || data.agreedAt || "")}</div>
    <div>LINE userId：${esc(data.liffUserId || "（非 LIFF 送出）")}</div>
    <div>資料哈希 SHA-256：${hash}</div>
    <div>客戶裝置：${ua}</div>
  </div>
</body>
</html>`;
}

// ======= 工具函式 =======
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function sha256(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map((b) => ("0" + ((b + 256) % 256).toString(16)).slice(-2)).join("");
}
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatDateForFilename(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}${m}${dd}_${hh}${mm}`;
}

// ======= 簽約完成 → 推 LINE 通知老闆 + 寫 log =======
function notifyBossNewContract(data, phone, pdfUrl) {
  const tsStr = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  const services = (data.services || []).join("/");
  const head = (data.contractType === "official") ? "📋 新定型化契約簽署" : "✅ 新簽約完成";
  const text =
    head + "\n" +
    "客戶：" + data.name + "\n寵物：" + data.petName + "\n" +
    "服務：" + (services || "（未選）") + "\n金額：NT$" + (data.amount || "（現場確認）") + "\n" +
    "合約：" + pdfUrl + "\n時間：" + tsStr;

  let status = "ok", errorMsg = "";
  try { if (!pushLine(text)) { status = "error"; errorMsg = "pushLine returned false"; } }
  catch (e) { status = "error"; errorMsg = String((e && e.message) || e); }

  try {
    const file = SpreadsheetApp.openByUrl(FILE_A_URL);
    const sheet = file.getSheetByName(SHEET_NOTIFY_LOG);
    if (sheet) {
      sheet.appendRow([new Date(), data.name || "", data.petName || "", data.amount || "", pdfUrl || "", data.liffUserId || "", status, errorMsg]);
    }
  } catch (logErr) { Logger.log("[notifyBoss] 寫 log 失敗：" + String(logErr)); }
}

function pushLine(text) {
  const props = PropertiesService.getScriptProperties();
  const TOKEN = props.getProperty("LINE_TOKEN");
  const TO = props.getProperty("BOSS_USER_ID");
  if (!TOKEN || !TO) { Logger.log("[pushLine] token/userId 未設定"); return false; }
  const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
    method: "post", contentType: "application/json",
    headers: { "Authorization": "Bearer " + TOKEN },
    payload: JSON.stringify({ to: TO, messages: [{ type: "text", text: String(text).substring(0, 4900) }] }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) { Logger.log("[pushLine] HTTP " + code + " " + res.getContentText().substring(0, 300)); return false; }
  return true;
}

// ======= 測試用（編輯器手動跑）=======
function testCheck() { Logger.log(findExistingContract("TEST_USER", "").signed); }
function testConfig() { Logger.log(JSON.stringify(getContractConfig())); }
function testDoPost() {
  const sig = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const body = JSON.stringify({
    name: "測試客戶", phone: "0912345678", petName: "測試寵物", petSpecies: "犬", breed: "米克斯",
    petAge: "3歲", petGender: "公", petNeuter: "已絕育", chipNo: "900000000000000",
    ownerAddress: "新竹市…", ownerIsSelf: "是", emergencyName: "王小明", emergencyPhone: "0922333444",
    personality: ["親近人", "不會咬人"], appearance: "正常", parasite: "無", medicalHistory: ["無"],
    payMethod: "現金", amount: "800", services: ["洗澡", "剪毛"],
    agreedAt: new Date().toISOString(), signaturePng: sig, submittedAt: new Date().toISOString(),
    liffUserId: "TEST_USER", userAgent: "test", contractType: "official",
  });
  Logger.log(doPost({ postData: { contents: body } }).getContent());
}
