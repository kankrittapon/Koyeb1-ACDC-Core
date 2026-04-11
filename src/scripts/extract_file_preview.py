import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from pypdf import PdfReader


MAX_PREVIEW_CHARS = 4000
MAX_SUMMARY_CHARS = 280
MAX_PDF_PAGES = 5
MAX_OCR_PAGES = 3


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


def run_tesseract(image_path: Path) -> str:
    process = subprocess.run(
        ["tesseract", str(image_path), "stdout", "-l", "tha+eng"],
        capture_output=True,
        text=True,
        check=False,
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr.strip() or "tesseract OCR failed")
    return process.stdout


def extract_image_ocr(file_path: Path) -> tuple[str | None, int | None]:
    preview = normalize_text(run_tesseract(file_path))
    return (preview or None, 1)


def extract_pdf_ocr(file_path: Path, page_count: int) -> tuple[str | None, int | None]:
    with tempfile.TemporaryDirectory(prefix="acdc-pdf-ocr-") as temp_dir:
        output_prefix = Path(temp_dir) / "page"
        process = subprocess.run(
            [
                "pdftoppm",
                "-f",
                "1",
                "-l",
                str(min(page_count, MAX_OCR_PAGES)),
                "-png",
                str(file_path),
                str(output_prefix),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if process.returncode != 0:
            raise RuntimeError(process.stderr.strip() or "pdftoppm failed")

        texts: list[str] = []
        for image_path in sorted(Path(temp_dir).glob("page-*.png")):
            extracted = run_tesseract(image_path)
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
            if not preview_text:
                preview_text, page_count = extract_pdf_ocr(file_path, page_count or MAX_OCR_PAGES)
        elif ext == ".docx":
            preview_text, page_count = extract_docx(file_path)
        elif ext in {".jpg", ".jpeg", ".png", ".webp"}:
            preview_text, page_count = extract_image_ocr(file_path)
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
