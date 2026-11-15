"""サポート／抵抗ラインの JS版（web/srlines.js）が chartapp の sr_lines.py と一致するかを調べるための正解データを作る。

chartapp の sr_lines.py で計算した結果を tests/sr_fixture.json に書く。tests/parity.html がこれを読んで突き合わせる。
実際の日足（bitbank・4銘柄）は、ここで一度だけ取って、足のデータごと fixture に入れる（テストは通信しない）。

使い方: <chartappの.venvのpython> tests/make_sr_fixture.py
        （chartapp の場所は環境変数 CHARTAPP_DIR で変えられる。既定は Z:\\UlteraProjects\\chartapp）
        通信できないときは、実データの分を飛ばして作る（--offline）
"""
import json
import os
import sys
from pathlib import Path

import numpy as np

CHARTAPP = Path(os.environ.get("CHARTAPP_DIR", r"Z:\UlteraProjects\chartapp"))
sys.path.insert(0, str(CHARTAPP))
import sr_lines as SR  # noqa: E402

OUT = Path(__file__).resolve().parent / "sr_fixture.json"
PAIRS = ["BTC/JPY", "SOL/JPY", "XRP/JPY", "ASTR/JPY"]


def hlc(close, spread):
    c = np.asarray(close, dtype=float)
    return c + spread, c - spread, c


def synthetic():
    rng = np.random.default_rng(7)
    n = 600
    x = np.arange(n)
    wave = 110 + 10 * np.sin(2 * np.pi * x / 40 - np.pi / 2)              # 100〜120を行き来する
    walk = 1_000_000 * np.exp(np.cumsum(rng.normal(0, 0.012, 900)))       # ふつうの値動き
    coarse = np.round((300 + np.cumsum(rng.normal(0, 3, 700))) / 0.5) * 0.5   # 刻みが粗い＝同じ価格が何度も出る（同値の比較・偶数丸めの確認）
    coarse = np.maximum(coarse, 20)
    flat = np.full(300, 100.0)
    surge = np.concatenate([np.full(100, 10.0), np.linspace(10, 100, 200)])
    tiny = 0.5 + 0.2 * np.sin(x / 17) + rng.normal(0, 0.01, n)           # 1円未満の銘柄（桁数の丸め）
    big = 12_000 + 1_500 * np.sin(x / 31) + rng.normal(0, 60, n)         # 丸めが 100 の位になる桁
    return [
        ("wave 100-120", *hlc(wave, 0.5)),
        ("random walk", *hlc(walk, walk * 0.004)),
        ("coarse ticks (ties)", *hlc(coarse, 0.5)),
        ("flat", *hlc(flat, 0.5)),
        ("surge", *hlc(surge, 1.0)),
        ("under 1 yen", *hlc(tiny, 0.01)),
        ("12,000 yen scale", *hlc(big, 30)),
    ]


def real(offline):
    if offline:
        return []
    import datafeed
    out = []
    for sym in PAIRS:
        df = datafeed.CcxtFeed("bitbank", sym, "1d").history(1500)
        out.append((f"bitbank {sym} 1d", df["high"].to_numpy(), df["low"].to_numpy(), df["close"].to_numpy()))
    return out


def main():
    cases = []
    for name, h, l, c in synthetic() + real("--offline" in sys.argv):
        lv = SR.levels(h, l, c)
        cases.append({
            "name": name,
            "high": [float(x) for x in h], "low": [float(x) for x in l], "close": [float(x) for x in c],
            "expected": {side: [{"price": float(o["price"]), "score": float(o["score"]), "important": bool(o["important"])} for o in lv[side]]
                         for side in ("support", "resistance")},
        })
    OUT.write_text(json.dumps({"cases": cases}), encoding="utf-8")
    print("wrote", OUT, OUT.stat().st_size, "bytes;", len(cases), "cases")
    for c in cases:
        e = c["expected"]
        print(" ", c["name"], "support", [o["price"] for o in e["support"]], "resistance", [o["price"] for o in e["resistance"]])


if __name__ == "__main__":
    main()
