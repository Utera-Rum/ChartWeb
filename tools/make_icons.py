"""アイコンのPNG（icon-192 / icon-512 / apple-touch-icon）を web/ に書き出す。icon.svg と同じ絵。
使い方: python tools/make_icons.py   （Pillow が必要）"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "web"
BG, UP, DOWN = "#131722", "#26a69a", "#ef5350"
# (ヒゲ上, ヒゲ下, 実体上, 実体下, 中心x, 色)  ※512基準
CANDLES = [(140, 380, 200, 320, 150, DOWN), (100, 340, 150, 290, 256, UP), (70, 300, 110, 260, 362, UP)]


def draw(size: int, rounded: bool) -> Image.Image:
    k = 4  # 縮小して滑らかにする
    s = size * k
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(s * 96 / 512) if rounded else 0
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=r, fill=BG)
    f = s / 512
    for top, bot, bt, bb, cx, col in CANDLES:
        w = max(2, int(14 * f))
        d.line((cx * f, top * f, cx * f, bot * f), fill=col, width=w)
        d.rounded_rectangle(((cx - 30) * f, bt * f, (cx + 30) * f, bb * f), radius=int(6 * f), fill=col)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    draw(192, True).save(OUT / "icon-192.png")
    draw(512, True).save(OUT / "icon-512.png")
    # iPhoneのホーム画面用は角丸なし（iOSが自分で丸める）
    draw(180, False).convert("RGB").save(OUT / "apple-touch-icon.png")
    print("OK", sorted(p.name for p in OUT.glob("*.png")))
