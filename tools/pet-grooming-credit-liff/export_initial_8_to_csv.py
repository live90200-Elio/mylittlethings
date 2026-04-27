# -*- coding: utf-8 -*-
"""
把現有 8 位客戶（在 C:/Users/ZING/Pictures/儲值5000 名單/create_储值单.py 裡）
轉成 Google Sheets「寵物店儲值帳本」可以直接匯入的 CSV 檔。

執行方式：
    python export_initial_8_to_csv.py

會產出 3 個檔案到本資料夾：
    - 交易明細.csv  → 匯入到「交易明細」分頁
    - 客戶總覽.csv  → 匯入到「客戶總覽」分頁
    - 方案設定.csv  → 匯入到「方案設定」分頁

匯入步驟（每個 CSV 都同樣做一次）：
    1. 在 Google Sheets 切到對應分頁（先確保第 1 列已建好標題）
    2. 檔案 → 匯入 → 上傳 → 選 CSV
    3. 匯入位置選「**附加到目前的工作表**」（Append to current sheet）
    4. 分隔符號選「**自動偵測**」
    5. 按「匯入資料」
"""
import csv
import importlib.util
import io
import os
import sys

# Windows cmd 預設 cp950 不吃 emoji，把 stdout 換成 UTF-8
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# === 從原 create_储值单.py 載入 customers 資料（不重複定義） ===
SOURCE_PY = r"C:\Users\ZING\Pictures\儲值5000 名單\create_储值单.py"

if not os.path.exists(SOURCE_PY):
    print(f"❌ 找不到來源檔：{SOURCE_PY}")
    sys.exit(1)

# 動態 import（檔名含中文路徑，用 importlib spec 比較穩）
spec = importlib.util.spec_from_file_location("create_storage_unit", SOURCE_PY)
mod = importlib.util.module_from_spec(spec)
# 注意：原 .py 跑到最後會 wb.save，會在 source 那個資料夾產生 xlsx — 我們不需要那個副作用
# 解法：用 monkeypatch 把 wb.save 改成 no-op
import openpyxl
_real_save = openpyxl.Workbook.save
openpyxl.Workbook.save = lambda self, *a, **kw: None
spec.loader.exec_module(mod)
openpyxl.Workbook.save = _real_save  # 還原以免影響其他事

customers = mod.customers
print(f"✅ 從來源讀到 {len(customers)} 位客戶")

# === 寫 交易明細.csv（扁平化） ===
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
ledger_path = os.path.join(OUT_DIR, "交易明細.csv")

with open(ledger_path, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    # ⚠️ 不寫 header（要附加到既有分頁，header 已經在第 1 列）
    for cust in customers:
        for row in cust["rows"]:
            # row = (日期, 儲值金額, 消費項目, 消費金額, 餘額, 簽名, 備註)
            date, topup, item, spent, balance, sign, note = row
            w.writerow([
                cust["phone"],   # A 電話
                cust["name"],    # B 客戶姓名
                date,            # C 日期
                topup,           # D 儲值金額
                item,            # E 消費項目
                spent,           # F 消費金額
                balance,         # G 餘額
                sign,            # H 簽名
                note,            # I 備註
            ])

print(f"✅ 寫好：{ledger_path}")

# === 寫 客戶總覽.csv（從交易明細最後一筆推算目前餘額） ===
summary_path = os.path.join(OUT_DIR, "客戶總覽.csv")
with open(summary_path, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    for idx, cust in enumerate(customers, 1):
        # 找最後一筆有「餘額」的當目前餘額
        last_balance = ""
        for r in reversed(cust["rows"]):
            if r[4] and r[4].strip():
                last_balance = r[4]
                break
        # 算消費筆數（只算有消費金額的）
        spent_count = sum(1 for r in cust["rows"] if r[3] and r[3].strip())
        # 找最後消費日
        last_spent_date = ""
        for r in reversed(cust["rows"]):
            if r[3] and r[3].strip():
                last_spent_date = r[0]
                break
        w.writerow([
            idx,                # A #
            cust["name"],       # B 客戶姓名
            cust["phone"],      # C 電話
            cust["pet"],        # D 寵物
            last_balance,       # E 目前餘額
            spent_count,        # F 消費筆數
            last_spent_date,    # G 最後消費日
            "",                 # H 備註
        ])

print(f"✅ 寫好：{summary_path}")

# === 寫 方案設定.csv（照圖片方案） ===
plans_path = os.path.join(OUT_DIR, "方案設定.csv")
with open(plans_path, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    plans = [
        ("入門", 3000, 400,  45, 1, "TRUE"),
        ("推薦", 5000, 600,  45, 2, "TRUE"),
        ("豪華", 8000, 1000, 45, 3, "TRUE"),
    ]
    for p in plans:
        w.writerow(p)

print(f"✅ 寫好：{plans_path}")
print("\n📋 接下來：")
print("  1. 老闆建好『寵物店儲值帳本』Sheets，4 個分頁的 header 都先填好")
print("  2. 三個 CSV 各自匯入到對應分頁（檔案→匯入→附加到目前的工作表）")
print("  3. 完成！LIFF 就能讀到資料了")
