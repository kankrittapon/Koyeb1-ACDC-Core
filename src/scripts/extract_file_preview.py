import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from pypdf import PdfReader


MAX_PREVIEW_CHARS = 4000
MAX_SUMMARY_CHARS = 280
MAX_PDF_PAGES = 5


def normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\x00", "")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:MAX_PREVIEW_CHARS]


def build_summary(preview_text: str | None) -> str | None:
    if not preview_text:
      return None
    lines = [line.strip() for line in preview_text.splitlines() if line.strip()]
    if not lines:
      return None
    return " | ".join(lines[:3])[:MAX_SUMMARY_CHARS]


def extract_pdf(file_path: Path) -> tuple[str | None, int | None]:
    reader = PdfReader(str(file_path))
    page_count = len(reader.pages)
    texts: list[str] = []
    for page in reader.pages[:MAX_PDF_PAGES]:
        extracted = page.extract_text() or ""
        if extracted.strip():
            texts.append(extracted)
        if sum(len(item) for item in texts) >= MAX_PREVIEW_CHARS:
            break
    preview = normalize_text("\n\n".join(texts))
    return (preview or None, page_count)


def extract_docx(file_path: Path) -> tuple[str | None, int | None]:
    with zipfile.ZipFile(file_path) as archive:
        xml_bytes = archive.read("word/document.xml")
    root = ET.fromstring(xml_bytes)
    texts = [node.text for node in root.iter() if node.text]
    preview = normalize_text("\n".join(texts))
    return (preview or None, 1)


def main() -> int:
    if len(sys.argv) < 2:
        print(
            json.dumps(
                {
                    "preview_text": None,
                    "summary_short": None,
                    "page_count": None,
                    "extraction_status": "failed",
                    "extraction_error": "missing file path",
                }
            )
        )
        return 1

    file_path = Path(sys.argv[1])
    ext = file_path.suffix.lower()

    try:
        if ext == ".pdf":
            preview_text, page_count = extract_pdf(file_path)
        elif ext == ".docx":
            preview_text, page_count = extract_docx(file_path)
        else:
            result = {
                "preview_text": None,
                "summary_short": None,
                "page_count": None,
                "extraction_status": "unsupported",
                "extraction_error": "structured preview extraction is not supported for this file type yet",
            }
            print(json.dumps(result, ensure_ascii=False))
            return 0

        result = {
            "preview_text": preview_text,
            "summary_short": build_summary(preview_text),
            "page_count": page_count,
            "extraction_status": "completed",
            "extraction_error": None,
        }
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        result = {
            "preview_text": None,
            "summary_short": None,
            "page_count": None,
            "extraction_status": "failed",
            "extraction_error": str(exc)[:500],
        }
        print(json.dumps(result, ensure_ascii=False))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
