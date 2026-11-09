"""JS版の計算が chartapp（Python/pandas版）と一致するかを調べるための正解データを作る。

chartapp の indicators.py / signals.py で計算した結果を tests/fixture.json に書く。
tests/parity.html がこれを読んで、web/ の indicators.js / signals.js の結果と突き合わせる。

使い方: <chartappの.venvのpython> tests/make_fixture.py
        （chartapp の場所は環境変数 CHARTAPP_DIR で変えられる。既定は Z:\\UlteraProjects\\chartapp）
"""
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

CHARTAPP = Path(os.environ.get("CHARTAPP_DIR", r"Z:\UlteraProjects\chartapp"))
sys.path.insert(0, str(CHARTAPP))
import indicators as IND  # noqa: E402
import signals as SIG  # noqa: E402

OUT = Path(__file__).resolve().parent / "fixture.json"
T0 = 1_700_000_000


def make_candles(kind: str, n: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    if kind == "walk":                      # ふつうの値動き
        c = 1_000_000 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))
        o = np.r_[c[0], c[:-1]]
        h = np.maximum(o, c) * (1 + rng.uniform(0, 0.004, n))
        l = np.minimum(o, c) * (1 - rng.uniform(0, 0.004, n))
        v = rng.uniform(1, 10, n) * np.where(rng.random(n) < 0.08, 4, 1)   # たまに出来高が急増
    elif kind == "trend":                   # ずっと上がり続けて、途中で完全に止まる（RSIの割り算が0になる所）
        c = 100 + np.arange(n) * 0.5
        c[n // 2: n // 2 + 60] = c[n // 2]                                  # 60本ずっと同じ価格
        o = np.r_[c[0], c[:-1]]
        h, l = np.maximum(o, c) + 0.1, np.minimum(o, c) - 0.1
        v = np.where(np.arange(n) % 50 < 5, 0.0, 3.0)                      # 出来高0の足も混ぜる
    else:                                   # 行って戻る（買い・売りが何度も出る）
        x = np.arange(n)
        c = 500 + 120 * np.sin(x / 25) + rng.normal(0, 4, n)
        o = np.r_[c[0], c[:-1]]
        h, l = np.maximum(o, c) + 2, np.minimum(o, c) - 2
        v = rng.uniform(1, 5, n) * np.where(rng.random(n) < 0.1, 3, 1)
    t = pd.to_datetime(T0 + np.arange(n) * 3600, unit="s", utc=True).tz_convert("Asia/Tokyo")
    return pd.DataFrame({"time": t, "open": o, "high": h, "low": l, "close": c, "volume": v})


def clean(a):
    """NaN/inf は null にする（JSONにNaNは書けない）"""
    out = []
    for x in np.asarray(a, dtype=float):
        out.append(None if not math.isfinite(x) else float(x))
    return out


def case(name, kind, n, seed, params: SIG.Params, js_params: dict):
    df = make_candles(kind, n, seed)
    d = IND.compute(df)
    ev = SIG.evaluate(d, params)
    last = n - 1
    explain = [[lbl, int(v), txt] for lbl, v, txt in SIG.explain(d, ev, last, params)]
    return {
        "name": name,
        "params": js_params,
        "candles": [
            {"time": int(T0 + i * 3600), "open": float(r.open), "high": float(r.high), "low": float(r.low), "close": float(r.close), "volume": float(r.volume)}
            for i, r in enumerate(df.itertuples())
        ],
        "expected": {
            "ma5": clean(d["ma5"]), "ma20": clean(d["ma20"]), "ma100": clean(d["ma100"]), "ma200": clean(d["ma200"]),
            "macd": clean(d["macd"]), "macdSig": clean(d["macd_sig"]), "macdHist": clean(d["macd_hist"]),
            "rsi": clean(d["rsi"]), "bbUp": clean(d["bb_up"]), "bbLo": clean(d["bb_lo"]),
            "spanA": clean(d["span_a"]), "spanB": clean(d["span_b"]),
            "votes": {k: [int(x) for x in ev[k]] for k in params.active()},
            "score": [int(x) for x in ev["score"]],
            "signal": [int(x) for x in ev["signal"]],
            "signalRaw": [int(x) for x in ev["signal_raw"]],
            "explainLast": explain,
            "verdictLast": SIG.verdict(int(ev["score"].iloc[last]), params)[0],
        },
    }


def main():
    all_on = SIG.Params(enabled={k: True for k, _, _ in SIG.RULES})
    default = SIG.Params()
    tuned = SIG.Params(enabled={k: True for k, _, _ in SIG.RULES}, rsi_lo=40.0, rsi_hi=60.0, vol_mult=1.2, vol_len=10, buy_th=2, sell_th=-1)

    def js(p: SIG.Params):
        return {"enabled": dict(p.enabled), "rsiLo": p.rsi_lo, "rsiHi": p.rsi_hi, "volMult": p.vol_mult, "volLen": p.vol_len, "buyTh": p.buy_th, "sellTh": p.sell_th}

    cases = [
        case("walk / 既定の設定", "walk", 900, 1, default, js(default)),
        case("walk / 全ルールON", "walk", 900, 2, all_on, js(all_on)),
        case("trend / 価格が止まる・出来高0", "trend", 700, 3, all_on, js(all_on)),
        case("wave / 基準を変えた設定", "wave", 800, 4, tuned, js(tuned)),
        case("短い（200本未満）", "walk", 120, 5, all_on, js(all_on)),
    ]
    OUT.write_text(json.dumps({"cases": cases}), encoding="utf-8")
    print("wrote", OUT, OUT.stat().st_size, "bytes;", len(cases), "cases")
    for c in cases:
        e = c["expected"]
        print(" ", c["name"], "signals:", sum(1 for s in e["signal"] if s), "verdict:", e["verdictLast"])


if __name__ == "__main__":
    main()
