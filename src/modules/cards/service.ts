import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import QRCode from "qrcode";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderDescription(description?: string): string {
  if (!description?.trim()) {
    return "";
  }

  const lines = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<div class="event-description-line">${escapeHtml(line)}</div>`)
    .join("");

  return `<div class="event-description">${lines}</div>`;
}

function buildCardHtml(input: {
  dateLabel: string;
  qrDataUrl: string;
  events: Array<{
    start: string;
    end: string;
    title: string;
    location?: string;
    description?: string;
  }>;
}): string {
  const rows =
    input.events.length > 0
      ? input.events
          .map((event) => {
            const location = event.location?.trim()
              ? `<div class="event-location">สถานที่: ${escapeHtml(event.location.trim())}</div>`
              : "";
            const description = renderDescription(event.description);

            return `
              <section class="event-row">
                <div class="event-time">
                  <div class="event-start">${escapeHtml(event.start)}</div>
                  <div class="event-end">${escapeHtml(event.end)}</div>
                </div>
                <div class="event-accent"></div>
                <div class="event-content">
                  <div class="event-title">${escapeHtml(event.title)}</div>
                  ${location}
                  ${description}
                </div>
              </section>
            `;
          })
          .join("")
      : `
        <section class="event-row">
          <div class="event-time">
            <div class="event-start">--:--</div>
            <div class="event-end">--:--</div>
          </div>
          <div class="event-accent"></div>
          <div class="event-content">
            <div class="event-title">ไม่พบตารางงาน</div>
          </div>
        </section>
      `;

  return `
    <!doctype html>
    <html lang="th">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          :root {
            color-scheme: light;
          }

          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            background: #eef2f7;
            font-family: "Noto Sans Thai", "Tahoma", sans-serif;
          }

          .card {
            width: 1000px;
            min-height: 440px;
            margin: 0;
            padding: 56px 56px 48px;
            background:
              radial-gradient(circle at top left, rgba(61, 163, 95, 0.14), transparent 36%),
              linear-gradient(180deg, #ffffff 0%, #f7faf8 100%);
            color: #111827;
          }

          .header {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 24px;
            margin-bottom: 26px;
          }

          .header-title {
            max-width: 640px;
          }

          .label {
            margin-bottom: 10px;
            font-size: 18px;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: #3b7a57;
          }

          .date {
            margin: 0;
            font-size: 56px;
            font-weight: 800;
            line-height: 1.08;
            letter-spacing: -0.03em;
          }

          .qr {
            width: 180px;
            height: 180px;
            padding: 12px;
            border: 1px solid rgba(15, 23, 42, 0.08);
            border-radius: 24px;
            background: #ffffff;
            box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08);
          }

          .events {
            display: flex;
            flex-direction: column;
            gap: 18px;
          }

          .event-row {
            display: grid;
            grid-template-columns: 170px 8px 1fr;
            gap: 28px;
            align-items: stretch;
            padding: 14px 0;
          }

          .event-time {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding-top: 6px;
          }

          .event-start {
            font-size: 42px;
            font-weight: 700;
            line-height: 1;
            color: #111827;
          }

          .event-end {
            font-size: 38px;
            font-weight: 600;
            line-height: 1;
            color: #9ca3af;
          }

          .event-accent {
            border-radius: 999px;
            background: linear-gradient(180deg, #6fd68a 0%, #31a354 100%);
          }

          .event-content {
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding-right: 12px;
          }

          .event-title {
            font-size: 54px;
            font-weight: 800;
            line-height: 1.02;
            letter-spacing: -0.03em;
            color: #111827;
          }

          .event-location {
            font-size: 28px;
            font-weight: 600;
            line-height: 1.28;
            color: #6b7280;
          }

          .event-description {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-top: 2px;
          }

          .event-description-line {
            font-size: 24px;
            line-height: 1.35;
            color: #4b5563;
            white-space: pre-wrap;
            word-break: break-word;
          }
        </style>
      </head>
      <body>
        <main class="card">
          <header class="header">
            <div class="header-title">
              <div class="label">Daily Schedule</div>
              <h1 class="date">${escapeHtml(input.dateLabel)}</h1>
            </div>
            <img class="qr" src="${input.qrDataUrl}" alt="QR Code" />
          </header>
          <section class="events">
            ${rows}
          </section>
        </main>
      </body>
    </html>
  `;
}

export async function generateScheduleCard(input: {
  dateLabel: string;
  events: Array<{
    start: string;
    end: string;
    title: string;
    location?: string;
    description?: string;
  }>;
  qrUrl: string;
}): Promise<{ fileName: string; absolutePath: string; publicPath: string }> {
  const publicDir = path.join(process.cwd(), "public", "images");
  await fs.mkdir(publicDir, { recursive: true });

  const fileName = `${randomUUID()}.png`;
  const absolutePath = path.join(publicDir, fileName);
  const qrDataUrl = await QRCode.toDataURL(input.qrUrl, {
    margin: 1,
    width: 180
  });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    headless: true
  });

  try {
    const page = await browser.newPage({
      viewport: {
        width: 1000,
        height: 1200
      },
      deviceScaleFactor: 2
    });

    await page.setContent(
      buildCardHtml({
        dateLabel: input.dateLabel,
        qrDataUrl,
        events: input.events
      }),
      { waitUntil: "load" }
    );

    const card = page.locator(".card");
    await card.screenshot({
      path: absolutePath,
      type: "png"
    });
  } finally {
    await browser.close();
  }

  return {
    fileName,
    absolutePath,
    publicPath: `/images/${fileName}`
  };
}
