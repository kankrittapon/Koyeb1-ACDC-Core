import sys
import json
import argparse
import qrcode
from PIL import Image, ImageDraw, ImageFont
import os


def wrap_text(text, font, max_width, draw):
    if not text:
        return []
    lines = []
    current_line = ""
    for char in text:
        test_line = current_line + char
        bbox = draw.textbbox((0, 0), test_line, font=font)
        w = bbox[2] - bbox[0]
        if w <= max_width:
            current_line = test_line
        else:
            if current_line == "":
                lines.append(test_line)
                current_line = ""
            else:
                lines.append(current_line)
                current_line = char
    if current_line:
        lines.append(current_line)
    return lines


def wrap_block(text, font, max_width, draw):
    if not text:
        return []

    wrapped = []
    for paragraph in text.splitlines():
        stripped = paragraph.strip()
        if not stripped:
            wrapped.append("")
            continue
        wrapped.extend(wrap_text(stripped, font, max_width, draw))
    return wrapped


def load_font(size, bold=False):
    candidates = []
    if bold:
        candidates.extend(
            [
                os.environ.get("CARD_FONT_BOLD"),
                "/usr/share/fonts/noto/NotoSansThai-Bold.ttf",
                "/usr/share/fonts/noto/NotoSerifThai-Bold.ttf",
                "/usr/share/fonts/TTF/NotoSansThai-Bold.ttf",
                "C:/Windows/Fonts/tahoma.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            ]
        )
    else:
        candidates.extend(
            [
                os.environ.get("CARD_FONT_REGULAR"),
                "/usr/share/fonts/noto/NotoSansThai-Regular.ttf",
                "/usr/share/fonts/noto/NotoSerifThai-Regular.ttf",
                "/usr/share/fonts/TTF/NotoSansThai-Regular.ttf",
                "C:/Windows/Fonts/tahoma.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            ]
        )

    for font_path in candidates:
        if font_path and os.path.exists(font_path):
            try:
                return ImageFont.truetype(font_path, size)
            except Exception:
                pass

    return ImageFont.load_default()


def generate_card(date_str, events, qr_url, output_path):
    width = 1000
    header_height = 250
    footer_padding = 50
    right_padding = 40
    separator_x = 280
    text_max_width = width - separator_x - 60 - right_padding

    font_date = load_font(60, bold=True)
    font_time = load_font(45, bold=False)
    font_title = load_font(55, bold=True)
    font_small = load_font(40, bold=False)

    dummy_img = Image.new("RGB", (10, 10))
    dummy_draw = ImageDraw.Draw(dummy_img)

    event_layouts = []
    total_events_height = 0

    if not events:
        events = [{"start": "--:--", "end": "--:--", "title": "ไม่พบตารางงาน"}]

    for event in events:
        start_time = event.get("start", "--:--")
        end_time = event.get("end", "--:--")
        title = event.get("title", "ไม่ได้ระบุชื่องาน")
        location = event.get("location", "")
        description = event.get("description", "")

        wrapped_title = wrap_text(title, font_title, text_max_width, dummy_draw)
        loc_text = f"สถานที่: {location}" if location else ""
        wrapped_location = (
            wrap_block(loc_text, font_small, text_max_width, dummy_draw)
            if loc_text
            else []
        )
        desc_text = f"รายละเอียด: {description}" if description else ""
        wrapped_desc = (
            wrap_block(desc_text, font_small, text_max_width, dummy_draw)
            if desc_text
            else []
        )

        def get_lines_height(lines, font):
            if not lines:
                return 0
            h = 0
            for line in lines:
                if line == "":
                    h += 16
                    continue
                bbox = dummy_draw.textbbox((0, 0), line, font=font)
                h += (bbox[3] - bbox[1]) + 5
            return h

        title_h = get_lines_height(wrapped_title, font_title)
        loc_h = get_lines_height(wrapped_location, font_small)
        desc_h = get_lines_height(wrapped_desc, font_small)

        content_h = title_h + (loc_h + 10 if loc_h else 0) + (desc_h + 10 if desc_h else 0)
        row_height = max(140, content_h + 40)

        event_layouts.append(
            {
                "start": start_time,
                "end": end_time,
                "title_lines": wrapped_title,
                "loc_lines": wrapped_location,
                "desc_lines": wrapped_desc,
                "height": row_height,
            }
        )
        total_events_height += row_height

    height = header_height + total_events_height + footer_padding
    base = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(base)

    draw.text((60, 80), date_str, fill=(0, 0, 0), font=font_date)

    qr = qrcode.QRCode(version=1, box_size=10, border=1)
    qr.add_data(qr_url)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    qr_img = qr_img.resize((180, 180))
    base.paste(qr_img, (width - 180 - 60, 60))

    y_pos = header_height
    for layout in event_layouts:
        row_y = y_pos
        draw.text((60, row_y + 10), layout["start"], fill=(0, 0, 0), font=font_time)
        draw.text((60, row_y + 65), layout["end"], fill=(150, 150, 150), font=font_time)
        draw.rectangle(
            [separator_x, row_y, separator_x + 8, row_y + layout["height"] - 20],
            fill=(57, 181, 74),
        )

        content_y = row_y + 10
        for line in layout["title_lines"]:
            draw.text((separator_x + 40, content_y), line, fill=(0, 0, 0), font=font_title)
            bbox = draw.textbbox((0, 0), line, font=font_title)
            content_y += (bbox[3] - bbox[1]) + 5

        if layout["loc_lines"]:
            content_y += 10
            for line in layout["loc_lines"]:
                if line == "":
                    content_y += 16
                    continue
                draw.text((separator_x + 40, content_y), line, fill=(130, 130, 130), font=font_small)
                bbox = draw.textbbox((0, 0), line, font=font_small)
                content_y += (bbox[3] - bbox[1]) + 5

        if layout["desc_lines"]:
            content_y += 10
            for line in layout["desc_lines"]:
                if line == "":
                    content_y += 16
                    continue
                draw.text((separator_x + 40, content_y), line, fill=(130, 130, 130), font=font_small)
                bbox = draw.textbbox((0, 0), line, font=font_small)
                content_y += (bbox[3] - bbox[1]) + 5

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
