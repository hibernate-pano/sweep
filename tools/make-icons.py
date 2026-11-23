#!/usr/bin/env python3
"""生成扩展图标。

设计语言与面板一致：一段 3/4 的圆环 + 缺口处一块正在被移除的方块。
钴蓝底 + 近白环 —— 明暗两种浏览器主题下都看得清。
4 倍超采样后再缩放，保证 16px 也干净。

用法：python3 tools/make-icons.py
"""

from __future__ import annotations

import math
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "icons")

PAPER = (245, 247, 250)
COBALT = (47, 102, 232)
COBALT_DEEP = (20, 64, 180)
TRACK = (255, 255, 255)

SS = 8  # 超采样倍数


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_arc(draw, center, radius, width, start, end, color, cap=True):
    """画一段带圆角端点的圆弧。角度：0 度在 3 点方向，顺时针增大。"""
    cx, cy = center
    bbox = (cx - radius, cy - radius, cx + radius, cy + radius)
    draw.arc(bbox, start, end, fill=color, width=width)
    if cap:
        r = width / 2
        for angle in (start, end):
            x = cx + radius * math.cos(math.radians(angle))
            y = cy + radius * math.sin(math.radians(angle))
            draw.ellipse((x - r, y - r, x + r, y + r), fill=color)


def build(size: int, bold: bool = False) -> Image.Image:
    """bold=True 用于 16/32px：去掉轨道、加粗描边，保证小尺寸下依然清晰。"""
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 底板：从左上到右下的钴蓝渐变，模拟斜切的高光
    rounded_rect(draw, (0, 0, s - 1, s - 1), radius=int(s * 0.23), fill=COBALT_DEEP + (255,))
    for y in range(s):
        t = y / max(1, s - 1)
        c = tuple(
            round(COBALT_DEEP[i] + (COBALT[i] - COBALT_DEEP[i]) * (1 - t)) for i in range(3)
        )
        draw.line([(0, y), (s, y)], fill=c + (255,))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.23), fill=255)
    img.putalpha(mask)

    draw = ImageDraw.Draw(img)

    center = (s / 2, s / 2)
    radius = s * (0.27 if bold else 0.30)
    width = max(2, int(s * (0.13 if bold else 0.085)))

    # 轨道（完整的环，缺口处被方块占据）
    r = width / 2
    if not bold:
        draw.ellipse(
            (
                center[0] - radius - r,
                center[1] - radius - r,
                center[0] + radius + r,
                center[1] + radius + r,
            ),
            outline=(255, 255, 255, 60),
            width=width,
        )

    # 强调弧：从 300° 顺时针 300° 到 240°，缺口留在正上方
    draw_arc(draw, center, radius, width, 300, 600, PAPER + (255,))

    # 缺口里的方块
    block = s * (0.19 if bold else 0.15)
    bx = center[0] - block / 2
    by = center[1] - radius - block * 0.42
    rounded_rect(draw, (bx, by, bx + block, by + block), radius=int(block * 0.3), fill=PAPER + (255,))

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    plan = {16: True, 32: True, 48: False, 128: False}
    for size, bold in plan.items():
        img = build(size, bold)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        img.save(path, "PNG")
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
