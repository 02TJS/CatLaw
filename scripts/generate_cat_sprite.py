"""Generate the original rounded 4x2 chibi cat sheet used by Cat Workshop."""
from pathlib import Path

from PIL import Image, ImageDraw


OUT = Path(__file__).resolve().parents[1] / "src" / "assets" / "cat-workshop-sprite.png"
FRAME = 32
SCALE = 2

OUTLINE = "#493b35"
GINGER = "#f1a259"
GINGER_DARK = "#cc7040"
GINGER_LIGHT = "#ffc47c"
CREAM = "#fff0cf"
APRON = "#2d7773"
APRON_LIGHT = "#54a09a"
EYE = "#342e2c"
PINK = "#e99591"


def rect(draw: ImageDraw.ImageDraw, box, fill):
    draw.rectangle(box, fill=fill)


def rounded(draw: ImageDraw.ImageDraw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_frame(sheet: Image.Image, index: int):
    image = Image.new("RGBA", (FRAME, FRAME), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    working = index >= 4
    phase = index % 4
    bob = -1 if working and phase == 2 else 0

    # A thick curled tail gives the silhouette a soft, toy-like shape.
    tail_shapes = [
        [(21, 22), (27, 24), (29, 20), (28, 17)],
        [(21, 22), (27, 23), (29, 19), (27, 16)],
        [(21, 22), (27, 25), (30, 22), (29, 18)],
        [(21, 22), (26, 24), (29, 21), (28, 16)],
    ]
    tail = [(x, y + bob) for x, y in tail_shapes[phase]]
    draw.line(tail, fill=OUTLINE, width=6, joint="curve")
    draw.line(tail, fill=GINGER, width=3, joint="curve")
    rect(draw, (tail[-1][0] - 1, tail[-1][1] - 1, tail[-1][0] + 1, tail[-1][1] + 1), GINGER_LIGHT)

    # Short rounded body, tiny cream paws, and a broad apron.
    rounded(draw, (9, 15 + bob, 24, 29 + bob), 5, OUTLINE)
    rounded(draw, (11, 16 + bob, 22, 28 + bob), 4, GINGER)
    rounded(draw, (10, 25 + bob, 15, 30 + bob), 2, OUTLINE)
    rounded(draw, (18, 25 + bob, 23, 30 + bob), 2, OUTLINE)
    rect(draw, (11, 27 + bob, 14, 29 + bob), CREAM)
    rect(draw, (19, 27 + bob, 22, 29 + bob), CREAM)
    rounded(draw, (11, 17 + bob, 22, 28 + bob), 3, OUTLINE)
    rounded(draw, (12, 18 + bob, 21, 27 + bob), 2, APRON)
    rect(draw, (13, 19 + bob, 20, 20 + bob), APRON_LIGHT)
    rounded(draw, (15, 23 + bob, 18, 25 + bob), 1, APRON_LIGHT)
    rect(draw, (16, 23 + bob, 17, 24 + bob), CREAM)

    # Small ears behind an oversized round head.
    draw.polygon([(7, 8 + bob), (8, 2 + bob), (14, 5 + bob)], fill=OUTLINE)
    draw.polygon([(19, 5 + bob), (25, 2 + bob), (26, 9 + bob)], fill=OUTLINE)
    draw.polygon([(9, 6 + bob), (10, 4 + bob), (13, 6 + bob)], fill=PINK)
    draw.polygon([(20, 6 + bob), (24, 4 + bob), (24, 7 + bob)], fill=PINK)
    rounded(draw, (5, 4 + bob, 27, 20 + bob), 7, OUTLINE)
    rounded(draw, (7, 6 + bob, 25, 18 + bob), 6, GINGER)
    rect(draw, (8, 7 + bob, 12, 8 + bob), GINGER_LIGHT)
    rect(draw, (21, 7 + bob, 24, 8 + bob), GINGER_LIGHT)

    # Large shiny eyes, blush, and a tiny smiling muzzle.
    blink = (not working and phase == 1) or (working and phase == 3)
    if blink:
        rect(draw, (9, 11 + bob, 13, 11 + bob), EYE)
        rect(draw, (20, 11 + bob, 24, 11 + bob), EYE)
    else:
        rounded(draw, (9, 9 + bob, 13, 13 + bob), 1, EYE)
        rounded(draw, (20, 9 + bob, 24, 13 + bob), 1, EYE)
        rect(draw, (10, 9 + bob, 11, 10 + bob), CREAM)
        rect(draw, (21, 9 + bob, 22, 10 + bob), CREAM)
    rect(draw, (7, 14 + bob, 9, 15 + bob), PINK)
    rect(draw, (24, 14 + bob, 26, 15 + bob), PINK)
    rounded(draw, (12, 12 + bob, 21, 18 + bob), 3, CREAM)
    rect(draw, (15, 13 + bob, 18, 14 + bob), PINK)
    rect(draw, (16, 15 + bob, 17, 15 + bob), OUTLINE)
    rect(draw, (14, 16 + bob, 15, 16 + bob), OUTLINE)
    rect(draw, (18, 16 + bob, 19, 16 + bob), OUTLINE)

    # Working paws alternate slowly near the face instead of flailing outward.
    if working:
        if phase in (0, 3):
            rounded(draw, (6, 17 + bob, 12, 23 + bob), 2, OUTLINE)
            rounded(draw, (7, 17 + bob, 11, 21 + bob), 2, GINGER)
            rect(draw, (7, 17 + bob, 10, 18 + bob), CREAM)
        else:
            rounded(draw, (21, 17 + bob, 27, 23 + bob), 2, OUTLINE)
            rounded(draw, (22, 17 + bob, 26, 21 + bob), 2, GINGER)
            rect(draw, (23, 17 + bob, 26, 18 + bob), CREAM)
    else:
        rounded(draw, (7, 18 + bob, 12, 24 + bob), 2, OUTLINE)
        rounded(draw, (8, 19 + bob, 11, 23 + bob), 1, GINGER)
        rounded(draw, (21, 18 + bob, 26, 24 + bob), 2, OUTLINE)
        rounded(draw, (22, 19 + bob, 25, 23 + bob), 1, GINGER)

    sheet.alpha_composite(image, ((index % 4) * FRAME, (index // 4) * FRAME))


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    low_res = Image.new("RGBA", (FRAME * 4, FRAME * 2), (0, 0, 0, 0))
    for frame_index in range(8):
        draw_frame(low_res, frame_index)
    final = low_res.resize((low_res.width * SCALE, low_res.height * SCALE), Image.Resampling.NEAREST)
    final.save(OUT, optimize=True)
    print(f"wrote {OUT} ({final.width}x{final.height})")


if __name__ == "__main__":
    main()
