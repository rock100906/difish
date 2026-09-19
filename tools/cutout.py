# -*- coding: utf-8 -*-
"""
cutout.py — 纯色背景抠图工具
用法：py cutout.py <图片路径> [阈值]
  - 自动检测图片四角的背景色（纯白/纯绿/纯黑等都可以）
  - 把接近背景色的像素变成透明，保存为 *_transparent.png
  - 阈值：0~100，默认 30（越大抠得越狠，越小越保守）

用法示例：
  py cutout.py D:\\图片\\whale.jpg
  py cutout.py D:\\图片\\whale.jpg 45
"""
import sys
from pathlib import Path
from PIL import Image


def detect_bg_color(img):
    """沿四边采样，取出现最多的颜色作为背景色。
    比"四角平均"抗干扰：即使主体延伸到部分边缘，众数仍是背景色。"""
    from collections import Counter
    w, h = img.size
    c = Counter()
    step = max(2, min(w, h) // 120)
    for x in range(0, w, step):
        c[img.getpixel((x, 2))] += 1
        c[img.getpixel((x, h - 3))] += 1
    for y in range(0, h, step):
        c[img.getpixel((2, y))] += 1
        c[img.getpixel((w - 3, y))] += 1
    return c.most_common(1)[0][0]


def cutout(src, threshold=30):
    img = Image.open(src).convert("RGBA")
    bg = detect_bg_color(img)
    w, h = img.size
    px = img.load()
    t2 = threshold * threshold * 3  # 距离平方阈值

    def close(r, g, b):
        dr = r - bg[0]; dg = g - bg[1]; db = b - bg[2]
        return dr * dr + dg * dg + db * db <= t2

    # 第一遍：标记接近背景的像素
    alpha = bytearray(w * h)
    i = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            alpha[i] = 0 if close(r, g, b) else 255
            i += 1

    # 边缘羽化：与保留像素相邻的背景像素给半透明，减少白边
    def neighbor_saved(x, y):
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and alpha[ny * w + nx] == 255:
                return True
        return False

    i = 0
    for y in range(h):
        for x in range(w):
            if alpha[i] == 0 and neighbor_saved(x, y):
                alpha[i] = 120  # 半透明边缘
            i += 1

    # 应用 alpha
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    oa = out.load()
    i = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            oa[x, y] = (r, g, b, alpha[i])
            i += 1

    # 裁剪到内容区域（去掉透明边缘空白）
    bbox = out.getbbox()
    if bbox:
        out = out.crop(bbox)

    dst = Path(src).with_name(Path(src).stem + "_transparent.png")
    out.save(dst)
    print(f"[完成] {dst} ({out.size[0]}x{out.size[1]}, 背景色 {bg}, 阈值 {threshold})")
    return str(dst)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("用法：py cutout.py <图片路径> [阈值]")
    t = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    cutout(sys.argv[1], t)
