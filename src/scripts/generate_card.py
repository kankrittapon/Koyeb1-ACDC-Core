import sys
import io
import json
import argparse
import qrcode
from PIL import Image
import cairo
import gi

gi.require_version("Pango", "1.0")
gi.require_version("PangoCairo", "1.0")

from gi.repository import Pango, PangoCairo  # noqa: E402


FONT_FAMILY = "Noto Sans Thai"


def render_text_block(text, font_size, max_width, color=(0, 0, 0), bold=False):
    if not text:
        return None

    text = text.strip()
    if not text:
        return None

    font_weight = "Bold" if bold else "Regular"
    font_desc = Pango.FontDescription(f"{FONT_FAMILY} {font_weight} {font_size}")

    probe_surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, max_width, 2000)
    probe_ctx = cairo.Context(probe_surface)
    probe_layout = PangoCairo.create_layout(probe_ctx)
    probe_layout.set_font_description(font_desc)
    probe_layout.set_width(max_width * Pango.SCALE)
    probe_layout.set_wrap(Pango.WrapMode.WORD_CHAR)
    probe_layout.set_text(text, -1)
    _, logical = probe_layout.get_pixel_extents()

    height = max(logical.height + 8, font_size + 12)

    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, max_width, height)
    ctx = cairo.Context(surface)
    ctx.set_source_rgba(1, 1, 1, 0)
    ctx.paint()

    layout = PangoCairo.create_layout(ctx)
    layout.set_font_description(font_desc)
    layout.set_width(max_width * Pango.SCALE)
    layout.set_wrap(Pango.WrapMode.WORD_CHAR)
    layout.set_text(text, -1)

    ctx.set_source_rgba(color[0] / 255, color[1] / 255, color[2] / 255, 1)
    PangoCairo.show_layout(ctx, layout)

    buffer = io.BytesIO()
    surface.write_to_png(buffer)
    buffer.seek(0)
    return Image.open(buffer).convert("RGBA")


def generate_card(date_str, events, qr_url, output_path):
    width = 1000
    header_height = 250
    footer_padding = 50
    separator_x = 280
    text_max_width = width - separator_x - 100

    if not events:
        events = [{"start": "--:--", "end": "--:--", "title": "ไม่พบตารางงาน"}]

    qr = qrcode.QRCode(version=1, box_size=10, border=1)
    qr.add_data(qr_url)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    qr_img = qr_img.resize((180, 180))

    event_layouts = []
    total_events_height = 0

    for event in events:
        start_time = render_text_block(event.get("start", "--:--"), 45, 170, bold=False)
        end_time = render_text_block(event.get("end", "--:--"), 45, 170, color=(150, 150, 150), bold=False)
        title = render_text_block(event.get("title", "ไม่ได้ระบุชื่องาน"), 55, text_max_width, bold=True)

        location_text = f"สถานที่: {event.get('location', '')}".strip()
        if location_text == "สถานที่:":
            location_text = ""
        location = render_text_block(location_text, 36, text_max_width, color=(120, 120, 120), bold=False)

        description_text = event.get("description", "").strip()
        if description_text:
          description_text = f"รายละเอียด: {description_text}"
        description = render_text_block(description_text, 34, text_max_width, color=(120, 120, 120), bold=False)

        content_height = 0
        for image, spacing in ((title, 10), (location, 10), (description, 0)):
            if image:
                content_height += image.height + spacing

        row_height = max(160, content_height + 30)
        total_events_height += row_height

        event_layouts.append(
            {
                "start": start_time,
                "end": end_time,
                "title": title,
                "location": location,
                "description": description,
                "height": row_height,
            }
        )

    height = header_height + total_events_height + footer_padding
    base = Image.new("RGB", (width, height), (255, 255, 255))

    date_block = render_text_block(date_str, 60, 620, bold=True)
    if date_block:
        base.paste(date_block.convert("RGB"), (60, 80), date_block)

    base.paste(qr_img, (width - 240, 60))

    y_pos = header_height
    for layout in event_layouts:
        row_y = y_pos

        if layout["start"]:
            base.paste(layout["start"].convert("RGB"), (60, row_y + 10), layout["start"])
        if layout["end"]:
            base.paste(layout["end"].convert("RGB"), (60, row_y + 68), layout["end"])

        separator = Image.new("RGB", (8, layout["height"] - 20), (57, 181, 74))
        base.paste(separator, (separator_x, row_y))

        content_y = row_y + 8
        for key in ("title", "location", "description"):
            block = layout[key]
            if block:
                base.paste(block.convert("RGB"), (separator_x + 40, content_y), block)
                content_y += block.height + 10

        y_pos += layout["height"]

    base.save(output_path)
    print(f"Card generated successfully: {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate a customized event card")
    parser.add_argument("--date", required=True)
    parser.add_argument("--events", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True)

    args = parser.parse_args()

    try:
        events_list = json.loads(args.events)
        generate_card(args.date, events_list, args.url, args.output)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
