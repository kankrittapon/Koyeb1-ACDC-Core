import { Client, middleware, MiddlewareConfig, WebhookEvent } from "@line/bot-sdk";
import { NextFunction, Request, Response } from "express";
import { config } from "../../config";
import { supabaseAdmin } from "../../lib/supabase";
import { requestGatewayChat } from "../ai-gateway/client";
import { uploadFileToDrive } from "../drive/service";
import {
  bufferToReadable,
  createUploadedFileRecord,
  getLatestUploadedFileForLineUser,
  markUploadedFileDriveFailed,
  markUploadedFileDriveSynced,
  readStreamToBuffer,
  saveIncomingFileToDisk
} from "../files/service";
import { generateScheduleCard } from "../cards/service";

const lineConfig: MiddlewareConfig = {
  channelSecret: config.LINE_CHANNEL_SECRET ?? ""
};

export const lineMiddleware =
  config.ENABLE_LINE_WEBHOOK && config.LINE_CHANNEL_SECRET
    ? middleware(lineConfig)
    : (_req: Request, _res: Response, next: NextFunction) => next();

const lineClient =
  config.LINE_CHANNEL_ACCESS_TOKEN && config.LINE_CHANNEL_SECRET
    ? new Client({
        channelAccessToken: config.LINE_CHANNEL_ACCESS_TOKEN,
        channelSecret: config.LINE_CHANNEL_SECRET
      })
    : null;

const researchKeywords = [
  "ค้นหา",
  "วิจัย",
  "ข่าว",
  "ข้อมูล",
  "search",
  "research",
  "หาข้อมูล",
  "คืออะไร",
  "ทำไม",
  "ค้นคว้า"
];

const calendarManagerRoles = new Set(["BOSS", "ADMIN", "SECRETARY"]);
const summaryRoles = new Set(["BOSS", "ADMIN", "SECRETARY"]);
const staffMessagingRoles = new Set(["BOSS", "ADMIN", "SECRETARY"]);
const weekdayMap = new Map<string, number>([
  ["อาทิตย์", 0],
  ["วันอาทิตย์", 0],
  ["จันทร์", 1],
  ["วันจันทร์", 1],
  ["อังคาร", 2],
  ["วันอังคาร", 2],
  ["พุธ", 3],
  ["วันพุธ", 3],
  ["พฤหัส", 4],
  ["พฤหัสบดี", 4],
  ["วันพฤหัส", 4],
  ["วันพฤหัสบดี", 4],
  ["ศุกร์", 5],
  ["วันศุกร์", 5],
  ["เสาร์", 6],
  ["วันเสาร์", 6]
]);

const fileContextCache = new Map<
  string,
  {
    fileRecordId: string;
    fileName: string;
    originalFileName?: string | null;
    fileUrl: string;
    localUrl?: string | null;
    localPath?: string | null;
    mimeType: string;
    timestamp: number;
  }
>();
const aiModeState = new Map<string, number>();
const AI_MODE_IDLE_MS = 15 * 60 * 1000;

const thaiWeekdayShort = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัส", "ศุกร์", "เสาร์"];
const thaiMonthShort = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค."
];

type BangkokDateParts = {
  year: number;
  month: number;
  day: number;
};

type QuickEventPayload = {
  title: string;
  startAt: string;
  endAt: string;
  locationDisplayName?: string | null;
  description?: string | null;
  dressCode?: string | null;
  note?: string | null;
  taskDetails?: string | null;
};

type FlexMessageOptions = {
  title?: string;
  accentColor?: string;
  quickReplyExit?: boolean;
};

type FileDeliveryCardInput = {
  senderRole: string;
  instruction: string;
  fileRecordId: string;
  fileName: string;
  openUrl: string;
  driveUrl?: string | null;
};

function getLineClient(): Client {
  if (!lineClient) {
    throw new Error("LINE client is not configured");
  }

  return lineClient;
}

function isResearchRequest(text: string): boolean {
  return researchKeywords.some((keyword) => text.includes(keyword));
}

function isExitAICommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === "exit" || normalized === "ออกจาก ai" || normalized === "จบ ai";
}

function isAIInvocation(text: string): boolean {
  return /^ai(?:\s+.+)?$/i.test(text.trim());
}

function enterAIMode(lineUserId: string): void {
  aiModeState.set(lineUserId, Date.now() + AI_MODE_IDLE_MS);
}

function clearAIMode(lineUserId: string): void {
  aiModeState.delete(lineUserId);
}

function isAIModeActive(lineUserId: string): boolean {
  const expiresAt = aiModeState.get(lineUserId);
  if (!expiresAt) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    aiModeState.delete(lineUserId);
    return false;
  }
  return true;
}

function refreshAIMode(lineUserId: string): void {
  if (isAIModeActive(lineUserId)) {
    aiModeState.set(lineUserId, Date.now() + AI_MODE_IDLE_MS);
  }
}

function canManageCalendar(role: string): boolean {
  return calendarManagerRoles.has(role.toUpperCase());
}

function canRequestSummary(role: string): boolean {
  return summaryRoles.has(role.toUpperCase());
}

function canMessageStaff(role: string): boolean {
  return staffMessagingRoles.has(role.toUpperCase());
}

function parseDateInput(input: string, endOfDay = false): Date | null {
  const trimmed = input.trim();
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const date = new Date(Number(year), Number(month) - 1, Number(day), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    const date = new Date(Number(year), Number(month) - 1, Number(day), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (endOfDay) {
    parsed.setHours(23, 59, 59, 999);
  }

  return parsed;
}

function parseDateTimeInput(input: string): Date | null {
  const trimmed = input.trim();
  const localMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/
  );
  if (localMatch) {
    const [, year, month, day, hour, minute, second] = localMatch;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second ?? "0"),
      0
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getBangkokDateParts(now = new Date()): BangkokDateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const valueOf = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: valueOf("year"),
    month: valueOf("month"),
    day: valueOf("day")
  };
}

function getBangkokDateTimeParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  }).formatToParts(date);

  const valueOf = (type: "year" | "month" | "day" | "hour" | "minute") =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const weekdayToken = parts.find((part) => part.type === "weekday")?.value ?? "";
  const weekdayMapEn: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return {
    year: valueOf("year"),
    month: valueOf("month"),
    day: valueOf("day"),
    hour: valueOf("hour"),
    minute: valueOf("minute"),
    weekday: weekdayMapEn[weekdayToken] ?? 0
  };
}

function toBangkokDateObject(parts: BangkokDateParts): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0));
}

function datePartsToBangkokIso(
  parts: BangkokDateParts,
  hour: number,
  minute: number
): string {
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, hour - 7, minute, 0, 0)
  ).toISOString();
}

function toTimeParts(timeInput: string): { hour: number; minute: number } | null {
  const normalized = timeInput.trim().replace(".", ":");
  const compact = normalized.match(/^(\d{1,2})(\d{2})$/);
  if (compact) {
    const hour = Number(compact[1]);
    const minute = Number(compact[2]);
    if (hour > 23 || minute > 59) {
      return null;
    }
    return { hour, minute };
  }

  const colon = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (!colon) {
    return null;
  }

  const hour = Number(colon[1]);
  const minute = Number(colon[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }

  return { hour, minute };
}

function parseTimeRangeInput(input: string): {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
} | null {
  const normalized = input
    .trim()
    .replace(/\s+/g, " ")
    .replace(/–|—|ถึง/gi, "-");

  const rangeMatch = normalized.match(/^(.+?)\s*-\s*(.+)$/);
  if (rangeMatch) {
    const start = toTimeParts(rangeMatch[1]);
    const end = toTimeParts(rangeMatch[2]);
    if (!start || !end) {
      return null;
    }
    return {
      startHour: start.hour,
      startMinute: start.minute,
      endHour: end.hour,
      endMinute: end.minute
    };
  }

  const single = toTimeParts(normalized);
  if (!single) {
    return null;
  }

  const fallbackEnd = new Date(2000, 0, 1, single.hour, single.minute, 0, 0);
  fallbackEnd.setHours(fallbackEnd.getHours() + 1);

  return {
    startHour: single.hour,
    startMinute: single.minute,
    endHour: fallbackEnd.getHours(),
    endMinute: fallbackEnd.getMinutes()
  };
}

function resolveDayExpression(dayInput: string, now = new Date()): BangkokDateParts | null {
  const trimmed = dayInput.trim().toLowerCase();
  const baseParts = getBangkokDateParts(now);
  const base = toBangkokDateObject(baseParts);

  if (trimmed === "วันนี้") {
    return baseParts;
  }

  if (trimmed === "พรุ่งนี้") {
    const date = new Date(base);
    date.setUTCDate(date.getUTCDate() + 1);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate()
    };
  }

  if (trimmed === "มะรืน") {
    const date = new Date(base);
    date.setUTCDate(date.getUTCDate() + 2);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate()
    };
  }

  const explicit = parseDateInput(dayInput, false);
  if (explicit) {
    return {
      year: explicit.getFullYear(),
      month: explicit.getMonth() + 1,
      day: explicit.getDate()
    };
  }

  for (const [label, weekday] of weekdayMap.entries()) {
    if (trimmed === label.toLowerCase() || trimmed === `${label.toLowerCase()}นี้`) {
      const date = new Date(base);
      let diff = (weekday - date.getUTCDay() + 7) % 7;
      if (diff === 0) {
        diff = 7;
      }
      date.setUTCDate(date.getUTCDate() + diff);
      return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate()
      };
    }

    if (trimmed === `${label.toLowerCase()}หน้า`) {
      const date = new Date(base);
      let diff = (weekday - date.getUTCDay() + 7) % 7;
      if (diff === 0) {
        diff = 7;
      }
      date.setUTCDate(date.getUTCDate() + diff);
      return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate()
      };
    }
  }

  return null;
}

function buildEventDateTimes(dayInput: string, timeInput: string, now = new Date()) {
  const date = resolveDayExpression(dayInput, now);
  const timeRange = parseTimeRangeInput(timeInput);

  if (!date || !timeRange) {
    return null;
  }

  const startAt = datePartsToBangkokIso(date, timeRange.startHour, timeRange.startMinute);
  const endAt = datePartsToBangkokIso(date, timeRange.endHour, timeRange.endMinute);
  const start = new Date(startAt);
  let end = new Date(endAt);

  if (end.getTime() <= start.getTime()) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }

  return { startAt, endAt: end.toISOString() };
}

function formatStructuredDescription(parts: { taskDetails?: string }): string | null {
  const lines: string[] = [];

  if (parts.taskDetails) {
    const detailLines = parts.taskDetails
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (detailLines.length > 0) {
      lines.push("รายละเอียดงาน:");
      for (const line of detailLines) {
        lines.push(line.startsWith("-") ? line : `- ${line}`);
      }
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function parseStructuredQuickEvent(text: string) {
  const [firstLine, ...restLines] = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!firstLine) {
    return null;
  }

  const fields = firstLine.split(",").map((field) => field.trim());
  if (fields.length < 4) {
    return null;
  }

  const [dayField, timeField, outfitField, activityField, locationField, noteField, ...extraFields] = fields;
  const dateTimes = buildEventDateTimes(dayField, timeField);
  if (!dateTimes || !activityField) {
    return null;
  }

  const taskDetails = [...extraFields, ...restLines].filter(Boolean).join("\n");
  const description = formatStructuredDescription({
    taskDetails: taskDetails || undefined
  });

  return {
    title: activityField,
    startAt: dateTimes.startAt,
    endAt: dateTimes.endAt,
    locationDisplayName: locationField || null,
    description,
    dressCode: outfitField || null,
    note: noteField || null,
    taskDetails: taskDetails || null
  };
}

function parseNaturalQuickEvent(text: string) {
  const trimmed = text.trim();
  const dayPattern = Array.from(weekdayMap.keys())
    .sort((a, b) => b.length - a.length)
    .map((label) => `${label}(?:นี้|หน้า)?`);
  const regex = new RegExp(
    `^((?:วันนี้|พรุ่งนี้|มะรืน|${dayPattern.join("|")}))\\s+((?:\\d{3,4}|\\d{1,2}:\\d{2})(?:\\s*(?:-|–|—|ถึง)\\s*(?:\\d{3,4}|\\d{1,2}:\\d{2}))?)\\s+(.+)$`,
    "i"
  );

  const match = trimmed.match(regex);
  if (!match) {
    return null;
  }

  const [, dayField, timeField, rest] = match;
  const dateTimes = buildEventDateTimes(dayField, timeField);
  if (!dateTimes) {
    return null;
  }

  const locationMatch = rest.match(/(.+?)\s+(?:ที่|สถานที่)\s+(.+)$/i);
  const title = locationMatch ? locationMatch[1].trim() : rest.trim();
  const locationDisplayName = locationMatch ? locationMatch[2].trim() : null;

  return {
    title,
    startAt: dateTimes.startAt,
    endAt: dateTimes.endAt,
    locationDisplayName,
    description: null
  };
}

function formatThaiDate(date: Date): string {
  return date.toLocaleDateString("th-TH", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: config.APP_TIMEZONE
  });
}

function formatCardDateLabel(date: Date): string {
  const parts = getBangkokDateTimeParts(date);
  return `${thaiWeekdayShort[parts.weekday]} ${parts.day} ${thaiMonthShort[parts.month - 1]} ${parts.year + 543}`;
}

function formatCardTime(date: Date): string {
  const parts = getBangkokDateTimeParts(date);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

type DateRangePreset = {
  start: Date;
  end: Date;
  label: string;
  title: string;
};

function getRangeFromPreset(
  preset: "today" | "week" | "month" | "tomorrow" | "dayaftertomorrow" | "nextweek" | "nextmonth"
): DateRangePreset {
  const now = new Date();
  const today = getBangkokDateParts(now);
  const todayBase = toBangkokDateObject(today);

  if (preset === "today") {
    const start = new Date(Date.UTC(today.year, today.month - 1, today.day, -7, 0, 0, 0));
    const end = new Date(Date.UTC(today.year, today.month - 1, today.day, 16, 59, 59, 999));
    return {
      start,
      end,
      label: `ประจำวัน ${formatThaiDate(start)}`,
      title: "ตารางงานวันนี้"
    };
  }

  if (preset === "tomorrow" || preset === "dayaftertomorrow") {
    const date = new Date(todayBase);
    date.setUTCDate(date.getUTCDate() + (preset === "tomorrow" ? 1 : 2));
    const start = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), -7, 0, 0, 0)
    );
    const end = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 16, 59, 59, 999)
    );
    return {
      start,
      end,
      label: `ประจำวัน ${formatThaiDate(start)}`,
      title: preset === "tomorrow" ? "ตารางงานพรุ่งนี้" : "ตารางงานมะรืน"
    };
  }

  if (preset === "week") {
    const start = new Date(todayBase);
    const day = start.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    start.setUTCDate(start.getUTCDate() + diff);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    const startAt = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), -7, 0, 0, 0)
    );
    const endAt = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 16, 59, 59, 999)
    );
    return {
      start: startAt,
      end: endAt,
      label: `${formatThaiDate(startAt)} - ${formatThaiDate(endAt)}`,
      title: "ตารางงานสัปดาห์นี้"
    };
  }

  if (preset === "nextweek") {
    const currentWeek = getRangeFromPreset("week");
    const start = new Date(currentWeek.start.getTime() + 7 * 24 * 60 * 60 * 1000);
    const end = new Date(currentWeek.end.getTime() + 7 * 24 * 60 * 60 * 1000);
    return {
      start,
      end,
      label: `${formatThaiDate(start)} - ${formatThaiDate(end)}`,
      title: "ตารางงานสัปดาห์หน้า"
    };
  }

  const monthOffset = preset === "nextmonth" ? 1 : 0;
  const start = new Date(Date.UTC(today.year, today.month - 1 + monthOffset, 1, -7, 0, 0, 0));
  const end = new Date(
    Date.UTC(today.year, today.month + monthOffset, 0, 16, 59, 59, 999)
  );
  return {
    start,
    end,
    label: `${formatThaiDate(start)} - ${formatThaiDate(end)}`,
    title: preset === "nextmonth" ? "ตารางงานเดือนหน้า" : "ตารางงานเดือนนี้"
  };
}

type CalendarEventRow = {
  id: string;
  title: string;
  description?: string | null;
  dress_code?: string | null;
  note?: string | null;
  task_details?: string | null;
  start_at: string;
  end_at: string;
  location_display_name?: string | null;
  location_type?: string | null;
  created_at?: string | null;
};

async function getEventsBetween(start: Date, end: Date) {
  const { data, error } = await supabaseAdmin
    .from("calendar_events")
    .select("*")
    .gte("start_at", start.toISOString())
    .lte("start_at", end.toISOString())
    .order("start_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []) as CalendarEventRow[];
}

function buildEventLines(events: CalendarEventRow[]): string[] {
  return events.map((event, index) => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    const day = start.toLocaleDateString("th-TH", {
      day: "numeric",
      month: "short",
      timeZone: config.APP_TIMEZONE
    });
    const startTime = start.toLocaleTimeString("th-TH", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: config.APP_TIMEZONE
    });
    const endTime = end.toLocaleTimeString("th-TH", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: config.APP_TIMEZONE
    });
    const location = event.location_display_name ? ` • ${event.location_display_name}` : "";
    return `${index + 1}. ${day} ${startTime}-${endTime} • ${event.title}${location}`;
  });
}

function buildRichEventDescription(event: CalendarEventRow): string {
  const lines: string[] = [];

  if (event.description) {
    lines.push(event.description);
  }

  if (event.dress_code) {
    lines.push(`ชุด: ${event.dress_code}`);
  }

  if (event.note) {
    lines.push(`หมายเหตุ: ${event.note}`);
  }

  if (event.task_details) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("รายละเอียดงาน:");
    lines.push(...event.task_details.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }

  return lines.join("\n").trim();
}

function normalizeTextCommand(text: string): string {
  const trimmed = text.trim();
  const compact = trimmed.replace(/\s+/g, "");

  if (/^(วันนี้|พรุ่งนี้|มะรืน|(?:วัน)?(?:จันทร์|อังคาร|พุธ|พฤหัส|พฤหัสบดี|ศุกร์|เสาร์|อาทิตย์)(?:นี้|หน้า)?)$/i.test(trimmed)) {
    return `/clarify day | ${trimmed}`;
  }

  if (
    trimmed === "ตารางวันนี้" ||
    trimmed === "ดูตารางวันนี้" ||
    trimmed === "งานวันนี้" ||
    /^(ขอดู|ดู|มี)?งาน(อะไร)?(ที่ต้องทำ)?วันนี้(หน่อย)?(ครับ|คะ|ค่ะ)?$/i.test(compact) ||
    /^ตารางของ.*วันนี้$/i.test(trimmed)
  ) {
    return "/event today";
  }

  if (
    trimmed === "ตารางพรุ่งนี้" ||
    trimmed === "ดูตารางพรุ่งนี้" ||
    trimmed === "งานพรุ่งนี้" ||
    /^(ขอดู|ดู|มี)?งาน(อะไร)?(ที่ต้องทำ)?พรุ่งนี้(หน่อย)?(ครับ|คะ|ค่ะ)?$/i.test(compact)
  ) {
    return "/event tomorrow";
  }

  if (
    trimmed === "ตารางมะรืน" ||
    trimmed === "ดูตารางมะรืน" ||
    trimmed === "งานมะรืน" ||
    /^(ขอดู|ดู|มี)?งาน(อะไร)?(ที่ต้องทำ)?มะรืน(หน่อย)?(ครับ|คะ|ค่ะ)?$/i.test(compact)
  ) {
    return "/event dayaftertomorrow";
  }

  if (
    trimmed === "ตารางสัปดาห์นี้" ||
    trimmed === "ดูตารางสัปดาห์นี้" ||
    trimmed === "งานสัปดาห์นี้" ||
    trimmed === "สัปดาห์นี้ล่ะ" ||
    /^(ขอดู|ดู|มี)?งาน(อะไร)?สัปดาห์นี้(หน่อย)?(ครับ|คะ|ค่ะ)?$/i.test(compact) ||
    /^ตารางของ.*สัปดาห์นี้$/i.test(trimmed)
  ) {
    return "/event week";
  }

  if (
    trimmed === "ตารางสัปดาห์หน้า" ||
    trimmed === "ดูตารางสัปดาห์หน้า" ||
    trimmed === "งานสัปดาห์หน้า" ||
    /^(ขอดู|ดู|มี)?งาน(อะไร)?สัปดาห์หน้า(หน่อย)?(ครับ|คะ|ค่ะ)?$/i.test(compact) ||
    /^ตารางของ.*สัปดาห์หน้า$/i.test(trimmed)
  ) {
    return "/event nextweek";
  }

  if (
    trimmed === "ตารางเดือนนี้" ||
    trimmed === "ดูตารางเดือนนี้" ||
    trimmed === "งานเดือนนี้" ||
    /^(ขอดู|ดู|มี)?งาน(อะไร)?เดือนนี้(หน่อย)?(ครับ|คะ|ค่ะ)?$/i.test(compact)
  ) {
    return "/event month";
  }

  if (
    trimmed === "ตารางเดือนหน้า" ||
    trimmed === "ดูตารางเดือนหน้า" ||
    trimmed === "งานเดือนหน้า" ||
    /^(ขอดู|ดู|มี)?งาน(อะไร)?เดือนหน้า(หน่อย)?(ครับ|คะ|ค่ะ)?$/i.test(compact)
  ) {
    return "/event nextmonth";
  }

  if (trimmed === "สรุปงานวันนี้" || trimmed === "รายงานวันนี้") {
    return "/summary today";
  }

  if (trimmed === "สรุปงานพรุ่งนี้" || trimmed === "รายงานพรุ่งนี้") {
    return "/summary tomorrow";
  }

  if (trimmed === "สรุปงานมะรืน" || trimmed === "รายงานมะรืน") {
    return "/summary dayaftertomorrow";
  }

  if (trimmed === "สรุปงานสัปดาห์นี้" || trimmed === "รายงานสัปดาห์นี้") {
    return "/summary week";
  }

  if (trimmed === "สรุปงานสัปดาห์หน้า" || trimmed === "รายงานสัปดาห์หน้า") {
    return "/summary nextweek";
  }

  if (trimmed === "สรุปงานเดือนนี้" || trimmed === "รายงานเดือนนี้") {
    return "/summary month";
  }

  if (trimmed === "สรุปงานเดือนหน้า" || trimmed === "รายงานเดือนหน้า") {
    return "/summary nextmonth";
  }

  if (
    trimmed === "ขอการ์ดวันนี้" ||
    trimmed === "ขอการ์ดตารางวันนี้" ||
    trimmed === "ขอสรุปงานแบบรูป" ||
    trimmed === "ขอ qr" ||
    trimmed === "ขอ QR"
  ) {
    return "/card today";
  }

  const staffNaturalMatch = trimmed.match(/^ส่งข้อความให้\s+(.+?)\s+ว่า\s+(.+)$/i);
  if (staffNaturalMatch) {
    return `/staff send | ${staffNaturalMatch[1].trim()} | ${staffNaturalMatch[2].trim()}`;
  }

  const roleStaffMatch = trimmed.match(/^ส่งข้อความให้(?:โรล|role)\s+(.+?)\s+ว่า\s+(.+)$/i);
  if (roleStaffMatch) {
    return `/staff send | ${roleStaffMatch[1].trim()} | ${roleStaffMatch[2].trim()}`;
  }

  const assignMatch = trimmed.match(/^ส่งงานให้\s+(.+?)\s+(.+)$/i);
  if (assignMatch) {
    return `/staff send | ${assignMatch[1].trim()} | ${assignMatch[2].trim()}`;
  }

  const deleteNaturalMatch = trimmed.match(/^ลบกิจกรรม\s+(.+)$/i);
  if (deleteNaturalMatch) {
    return `/event delete | ${deleteNaturalMatch[1].trim()}`;
  }

  const rangeMatch = trimmed.match(/^ตารางช่วง\s+(.+?)\s+ถึง\s+(.+)$/i);
  if (rangeMatch) {
    return `/event range | ${rangeMatch[1].trim()} | ${rangeMatch[2].trim()}`;
  }

  const summaryRangeMatch = trimmed.match(/^สรุปงานช่วง\s+(.+?)\s+ถึง\s+(.+)$/i);
  if (summaryRangeMatch) {
    return `/summary range | ${summaryRangeMatch[1].trim()} | ${summaryRangeMatch[2].trim()}`;
  }

  const addNaturalMatch = trimmed.match(
    /^เพิ่มกิจกรรม\s+(.+?)\s+เริ่ม\s+(.+?)\s+จบ\s+(.+?)(?:\s+สถานที่\s+(.+))?$/i
  );
  if (addNaturalMatch) {
    const title = addNaturalMatch[1].trim();
    const start = addNaturalMatch[2].trim();
    const end = addNaturalMatch[3].trim();
    const location = addNaturalMatch[4]?.trim();
    return `/event add | ${title} | ${start} | ${end} | INTERNAL | ${location ?? ""}`;
  }

  const structuredQuickEvent = parseStructuredQuickEvent(text);
  if (structuredQuickEvent) {
    return `/event quick | ${JSON.stringify(structuredQuickEvent)}`;
  }

  const naturalQuickEvent = parseNaturalQuickEvent(text);
  if (naturalQuickEvent) {
    return `/event quick | ${JSON.stringify(naturalQuickEvent)}`;
  }

  return trimmed;
}

async function logWebhookEvent(event: WebhookEvent, status: string): Promise<void> {
  await supabaseAdmin.from("webhook_logs").insert({
    provider: "line",
    event_type: event.type,
    line_user_id: event.source.userId ?? null,
    request_id: "line_webhook",
    payload: event,
    status
  });
}

async function ensureLineUser(lineUserId: string) {
  const profile = await getLineClient().getProfile(lineUserId);

  const { data: existingUser, error: fetchError } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("line_user_id", lineUserId)
    .maybeSingle();

  if (fetchError) {
    throw fetchError;
  }

  if (!existingUser) {
    const { data: createdUser, error: createError } = await supabaseAdmin
      .from("users")
      .insert({
        line_user_id: lineUserId,
        line_display_name: profile.displayName,
        picture_url: profile.pictureUrl ?? null,
        role: "GUEST"
      })
      .select("*")
      .single();

    if (createError) {
      throw createError;
    }

    return createdUser;
  }

  const { data: updatedUser, error: updateError } = await supabaseAdmin
    .from("users")
    .update({
      line_display_name: profile.displayName,
      picture_url: profile.pictureUrl ?? null,
      updated_at: new Date().toISOString()
    })
    .eq("id", existingUser.id)
    .select("*")
    .single();

  if (updateError) {
    throw updateError;
  }

  return updatedUser;
}

async function logConversation(lineUserId: string, userId: string | null, message: string, botResponse: string) {
  await supabaseAdmin.from("conversation_logs").insert({
    user_id: userId,
    line_user_id: lineUserId,
    message,
    bot_response: botResponse,
    source: "line"
  });
}

function getDriveFolderId(role: string, mimeType: string): string | undefined {
  const normalizedRole = role.toUpperCase();

  const roleRootMap: Record<string, string | undefined> = {
    BOSS: config.GOOGLE_DRIVE_BOSS_ROOT_FOLDER,
    SECRETARY: config.GOOGLE_DRIVE_SECRETARY_ROOT_FOLDER,
    ADMIN: config.GOOGLE_DRIVE_ADMIN_ROOT_FOLDER,
    USER: config.GOOGLE_DRIVE_USER_ROOT_FOLDER,
    GUEST: config.GOOGLE_DRIVE_GUEST_ROOT_FOLDER
  };

  const roleImageMap: Record<string, string | undefined> = {
    BOSS: config.GOOGLE_DRIVE_BOSS_IMAGE_FOLDER,
    SECRETARY: config.GOOGLE_DRIVE_SECRETARY_IMAGE_FOLDER,
    ADMIN: config.GOOGLE_DRIVE_ADMIN_IMAGE_FOLDER,
    USER: config.GOOGLE_DRIVE_USER_IMAGE_FOLDER,
    GUEST: config.GOOGLE_DRIVE_GUEST_IMAGE_FOLDER
  };

  const roleFileMap: Record<string, string | undefined> = {
    BOSS: config.GOOGLE_DRIVE_BOSS_FILE_FOLDER,
    SECRETARY: config.GOOGLE_DRIVE_SECRETARY_FILE_FOLDER,
    ADMIN: config.GOOGLE_DRIVE_ADMIN_FILE_FOLDER,
    USER: config.GOOGLE_DRIVE_USER_FILE_FOLDER,
    GUEST: config.GOOGLE_DRIVE_GUEST_FILE_FOLDER
  };

  if (mimeType.startsWith("image/")) {
    return (
      roleImageMap[normalizedRole] ??
      config.GOOGLE_DRIVE_IMAGE_FOLDER ??
      roleRootMap[normalizedRole] ??
      config.GOOGLE_DRIVE_ROOT_FOLDER
    );
  }

  return (
    roleFileMap[normalizedRole] ??
    config.GOOGLE_DRIVE_FILE_FOLDER ??
    roleRootMap[normalizedRole] ??
    config.GOOGLE_DRIVE_ROOT_FOLDER
  );
}

function buildFlexTextMessage(text: string, options: FlexMessageOptions = {}) {
  const title = options.title ?? "ACDC Assistant";
  const accentColor = options.accentColor ?? "#3b7a57";

  return {
    type: "flex" as const,
    altText: `${title}: ${text}`.slice(0, 400),
    contents: {
      type: "bubble" as const,
      size: "giga",
      header: {
        type: "box" as const,
        layout: "vertical" as const,
        paddingAll: "16px",
        backgroundColor: accentColor,
        contents: [
          {
            type: "text" as const,
            text: title,
            color: "#ffffff",
            size: "lg",
            weight: "bold"
          }
        ]
      },
      body: {
        type: "box" as const,
        layout: "vertical" as const,
        paddingAll: "18px",
        spacing: "md",
        contents: text
          .split("\n")
          .map((line) => line.trim())
          .filter((line, index, arr) => line.length > 0 || arr[index - 1] !== "")
          .map((line) => ({
            type: "text" as const,
            text: line || " ",
            wrap: true,
            size: "md",
            color: line.startsWith("⚠️") || line.startsWith("❌") ? "#b91c1c" : "#111827"
          }))
      }
    },
    quickReply: options.quickReplyExit
      ? {
          items: [
            {
              type: "action" as const,
              action: {
                type: "message" as const,
                label: "Exit",
                text: "exit"
              }
            }
          ]
        }
      : undefined
  } as any;
}

function inferFlexOptions(text: string, overrides: FlexMessageOptions = {}): FlexMessageOptions {
  if (overrides.title) {
    return overrides;
  }

  if (text.startsWith("⚠️") || text.startsWith("❌")) {
    return { ...overrides, title: "แจ้งเตือน", accentColor: "#b91c1c" };
  }

  if (text.startsWith("✅")) {
    return { ...overrides, title: "สำเร็จ", accentColor: "#15803d" };
  }

  if (text.startsWith("📅")) {
    return { ...overrides, title: "ตารางงาน", accentColor: "#2563eb" };
  }

  if (text.startsWith("🧾")) {
    return { ...overrides, title: "สรุปงาน", accentColor: "#7c3aed" };
  }

  if (text.startsWith("📨")) {
    return { ...overrides, title: "ข้อความภายใน", accentColor: "#0f766e" };
  }

  return { ...overrides, title: "ACDC Assistant", accentColor: "#3b7a57" };
}

function buildFileDeliveryFlexMessage(input: FileDeliveryCardInput) {
  const actions: any[] = [
    {
      type: "button",
      style: "primary",
      color: "#2563eb",
      action: {
        type: "uri",
        label: "เปิดไฟล์",
        uri: input.openUrl
      }
    }
  ];

  if (input.driveUrl) {
    actions.push({
      type: "button",
      style: "secondary",
      action: {
        type: "uri",
        label: "Google Drive",
        uri: input.driveUrl
      }
    });
  }

  return {
    type: "flex" as const,
    altText: `ไฟล์จาก ${input.senderRole}: ${input.fileName}`,
    contents: {
      type: "bubble" as const,
      size: "giga",
      header: {
        type: "box" as const,
        layout: "vertical" as const,
        paddingAll: "16px",
        backgroundColor: "#0f766e",
        contents: [
          {
            type: "text" as const,
            text: "ไฟล์แนบพร้อมคำสั่ง",
            color: "#ffffff",
            size: "lg",
            weight: "bold"
          }
        ]
      },
      body: {
        type: "box" as const,
        layout: "vertical" as const,
        paddingAll: "18px",
        spacing: "md",
        contents: [
          {
            type: "text" as const,
            text: `จาก ${input.senderRole}`,
            size: "sm",
            color: "#475569"
          },
          {
            type: "text" as const,
            text: input.fileName,
            wrap: true,
            weight: "bold",
            size: "md",
            color: "#111827"
          },
          {
            type: "separator" as const,
            margin: "sm"
          },
          {
            type: "text" as const,
            text: input.instruction,
            wrap: true,
            size: "md",
            color: "#111827"
          }
        ]
      },
      footer: {
        type: "box" as const,
        layout: "vertical" as const,
        spacing: "sm",
        paddingAll: "16px",
        contents: actions
      }
    }
  } as any;
}

export async function pushTextMessage(
  lineUserId: string,
  text: string,
  options: FlexMessageOptions = {}
): Promise<void> {
  await getLineClient().pushMessage(lineUserId, buildFlexTextMessage(text, inferFlexOptions(text, options)));
}

export async function pushImageMessage(lineUserId: string, imageUrl: string): Promise<void> {
  await getLineClient().pushMessage(lineUserId, {
    type: "image",
    originalContentUrl: imageUrl,
    previewImageUrl: imageUrl
  });
}

async function replyText(
  replyToken: string,
  text: string,
  options: FlexMessageOptions = {}
): Promise<void> {
  await getLineClient().replyMessage(replyToken, buildFlexTextMessage(text, inferFlexOptions(text, options)));
}

function buildRoleContext(user: {
  role: string;
  nickname?: string | null;
  line_display_name?: string | null;
}) {
  return [
    "You are the ACDC Core assistant for internal staff operations.",
    `Current role: ${user.role}`,
    `Nickname: ${user.nickname ?? "-"}`,
    `LINE display name: ${user.line_display_name ?? "-"}`,
    "Respect role boundaries. Do not claim a calendar action has been completed unless the Koyeb1 backend actually performed it.",
    "If the request is informational, answer directly and clearly in Thai."
  ].join("\n");
}

async function findStaffUser(target: string) {
  const aliasLookup = await supabaseAdmin
    .from("user_aliases")
    .select("user_id, alias")
    .ilike("alias", target)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!aliasLookup.error && aliasLookup.data?.user_id) {
    const byAlias = await supabaseAdmin
      .from("users")
      .select("id, username, role, line_user_id, line_display_name, nickname")
      .eq("id", aliasLookup.data.user_id)
      .maybeSingle();

    if (byAlias.error) {
      throw byAlias.error;
    }

    if (byAlias.data) {
      return byAlias.data;
    }
  }

  const normalizedRole = target.toUpperCase();
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id, username, role, line_user_id, line_display_name, nickname")
    .or(
      `nickname.ilike.%${target}%,line_display_name.ilike.%${target}%,username.ilike.%${target}%,role.eq.${normalizedRole}`
    )
    .limit(1);

  if (error) {
    throw error;
  }

  return data?.[0] ?? null;
}

async function sendStaffMessage(input: {
  senderUserId: string | null;
  senderRole: string;
  target: string;
  message: string;
  includeCachedFile?: boolean;
  lineUserId: string;
  requestedFileName?: string | null;
}) {
  const targetUser = await findStaffUser(input.target);
  if (!targetUser || !targetUser.line_user_id) {
    return `⚠️ ไม่พบบุคคลที่สามารถรับข้อความได้จากคำว่า "${input.target}"`;
  }

  const cachedFile = input.includeCachedFile ? fileContextCache.get(input.lineUserId) : null;
  const latestUploadedFile =
    input.includeCachedFile && !cachedFile
      ? await getLatestUploadedFileForLineUser(input.lineUserId)
      : null;
  let fullMessage = `📨 ข้อความจาก ${input.senderRole}\n\n${input.message}`;

  const attachmentName =
    input.requestedFileName ??
    cachedFile?.originalFileName ??
    latestUploadedFile?.originalFileName ??
    cachedFile?.fileName ??
    latestUploadedFile?.fileName;
  const attachmentRecordId = cachedFile?.fileRecordId ?? latestUploadedFile?.id ?? null;
  const attachmentDriveUrl = cachedFile?.fileUrl || latestUploadedFile?.driveUrl;
  const attachmentLocalUrl = cachedFile?.localUrl || latestUploadedFile?.localDiskUrl;
  const shortOpenUrl =
    attachmentRecordId && config.PUBLIC_BASE_URL
      ? `${config.PUBLIC_BASE_URL}/f/${attachmentRecordId}`
      : attachmentLocalUrl || attachmentDriveUrl || null;

  if (attachmentName || attachmentDriveUrl || attachmentLocalUrl) {
    fullMessage += "\n\n📎 ไฟล์แนบพร้อมคำสั่ง";
    if (attachmentName) {
      fullMessage += `\nชื่อไฟล์: ${attachmentName}`;
    }
    fullMessage += `\nคำสั่งงาน: ${input.message}`;
    if (attachmentDriveUrl) {
      fullMessage += `\nGoogle Drive: ${attachmentDriveUrl}`;
    }
    if (attachmentLocalUrl) {
      fullMessage += `\nServer Copy: ${attachmentLocalUrl}`;
    }
  }

  if (attachmentName && shortOpenUrl) {
    await getLineClient().pushMessage(
      targetUser.line_user_id,
      buildFileDeliveryFlexMessage({
        senderRole: input.senderRole,
        instruction: input.message,
        fileRecordId: attachmentRecordId ?? "latest",
        fileName: attachmentName,
        openUrl: shortOpenUrl,
        driveUrl: attachmentDriveUrl || undefined
      })
    );
  } else {
    await pushTextMessage(targetUser.line_user_id, fullMessage);
  }

  await supabaseAdmin.from("staff_messages").insert({
    sender_user_id: input.senderUserId,
    target_user_id: targetUser.id,
    target_line_user_id: targetUser.line_user_id,
    message: input.message,
    file_url: attachmentDriveUrl ?? attachmentLocalUrl ?? null,
    status: "sent",
    sent_at: new Date().toISOString()
  });

  return `✅ ส่งไฟล์และข้อความถึง ${targetUser.nickname ?? targetUser.line_display_name ?? targetUser.username ?? input.target} เรียบร้อยแล้ว`;
}

async function createCalendarEventFromCommand(input: {
  title: string;
  startAt: string;
  endAt: string;
  locationType?: string;
  locationDisplayName?: string;
  description?: string | null;
  dressCode?: string | null;
  note?: string | null;
  taskDetails?: string | null;
  createdBy: string;
}) {
  const startDate = parseDateTimeInput(input.startAt);
  const endDate = parseDateTimeInput(input.endAt);

  if (!startDate || !endDate) {
    return "⚠️ รูปแบบวันเวลายังไม่ถูกต้องครับ ใช้รูปแบบเช่น 2026-04-10 09:00";
  }

  const insertPayload: Record<string, unknown> = {
    title: input.title,
    description: input.description ?? null,
    start_at: startDate.toISOString(),
    end_at: endDate.toISOString(),
    location_type: input.locationType ?? "INTERNAL",
    location_display_name: input.locationDisplayName ?? null,
    created_by: input.createdBy
  };

  if (input.dressCode) {
    insertPayload.dress_code = input.dressCode;
  }

  if (input.note) {
    insertPayload.note = input.note;
  }

  if (input.taskDetails) {
    insertPayload.task_details = input.taskDetails;
  }

  const { data, error } = await supabaseAdmin
    .from("calendar_events")
    .insert(insertPayload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return `✅ บันทึกกิจกรรม "${data.title}" เรียบร้อยแล้ว`;
}

async function deleteCalendarEventByKeyword(keyword: string) {
  const { data: events, error } = await supabaseAdmin
    .from("calendar_events")
    .select("*")
    .ilike("title", `%${keyword}%`)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    throw error;
  }

  const event = events?.[0];
  if (!event) {
    return `⚠️ ไม่พบกิจกรรมที่ตรงกับ "${keyword}"`;
  }

  const { error: deleteError } = await supabaseAdmin
    .from("calendar_events")
    .delete()
    .eq("id", event.id);

  if (deleteError) {
    throw deleteError;
  }

  return `🗑️ ลบกิจกรรม "${event.title}" เรียบร้อยแล้ว`;
}

async function getScheduleTextForRange(start: Date, end: Date, title: string, label: string) {
  const events = await getEventsBetween(start, end);

  if (events.length === 0) {
    return `📅 ${title}\n\nช่วง ${label}\nไม่มีตารางงานครับ`;
  }

  return `📅 ${title}\n\nช่วง ${label}\n${buildEventLines(events).join("\n")}`;
}

async function getSummaryTextForRange(start: Date, end: Date, title: string, label: string) {
  const events = await getEventsBetween(start, end);

  if (events.length === 0) {
    return `🧾 ${title}\n\nช่วง ${label}\nไม่มีรายการงานที่ต้องสรุปครับ`;
  }

  const total = events.length;
  const internalCount = events.filter((event) => event.location_type === "INTERNAL").length;
  const majorCount = events.filter((event) => event.location_type === "MAJOR_UNIT").length;
  const outsideCount = events.filter((event) => event.location_type === "OUTSIDE").length;

  return [
    `🧾 ${title}`,
    "",
    `ช่วง ${label}`,
    `รวมทั้งหมด ${total} งาน`,
    `- ในหน่วย ${internalCount}`,
    `- หน่วยใหญ่ ${majorCount}`,
    `- นอกพื้นที่ ${outsideCount}`,
    "",
    ...buildEventLines(events)
  ].join("\n");
}

async function createScheduleCard(lineUserId: string, requestedByUserId: string | null) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const { data, error } = await supabaseAdmin
    .from("calendar_events")
    .select("*")
    .gte("start_at", start.toISOString())
    .lte("start_at", end.toISOString())
    .order("start_at", { ascending: true });

  if (error) {
    throw error;
  }

  const dateLabel = new Intl.DateTimeFormat("th-TH", {
    timeZone: config.APP_TIMEZONE
  }).format(start);

  const qrUrl = config.DASHBOARD_CARD_URL ?? config.NEXTJS_FRONTEND_URL ?? "https://example.com";
  const card = await generateScheduleCard({
    dateLabel: formatCardDateLabel(start),
    qrUrl,
    events:
      data?.map((event) => ({
        start: formatCardTime(new Date(event.start_at)),
        end: formatCardTime(new Date(event.end_at)),
        title: event.title,
        location: event.location_display_name ?? "",
        description: buildRichEventDescription(event)
      })) ?? []
  });

  const imageUrl = `${config.PUBLIC_BASE_URL ?? ""}${card.publicPath}`;
  if (!config.PUBLIC_BASE_URL) {
    throw new Error("PUBLIC_BASE_URL is required to send schedule card images");
  }

  await getLineClient().pushMessage(lineUserId, {
    type: "image",
    originalContentUrl: imageUrl,
    previewImageUrl: imageUrl
  });

  await supabaseAdmin.from("generated_cards").insert({
    requested_by_user_id: requestedByUserId,
    target_date: start.toISOString().slice(0, 10),
    image_url: imageUrl,
    status: "completed",
    completed_at: new Date().toISOString()
  });

  return "✅ สร้างและส่งการ์ดตารางงานประจำวันเรียบร้อยแล้ว";
}

async function tryHandleCommand(input: {
  text: string;
  user: {
    id: string | null;
    role: string;
  };
  lineUserId: string;
}): Promise<string | null> {
  const trimmed = normalizeTextCommand(input.text);

  if (trimmed === "/event today") {
    const range = getRangeFromPreset("today");
    return getScheduleTextForRange(range.start, range.end, range.title, range.label);
  }

  if (trimmed === "/event tomorrow") {
    const range = getRangeFromPreset("tomorrow");
    return getScheduleTextForRange(range.start, range.end, range.title, range.label);
  }

  if (trimmed === "/event dayaftertomorrow") {
    const range = getRangeFromPreset("dayaftertomorrow");
    return getScheduleTextForRange(range.start, range.end, range.title, range.label);
  }

  if (trimmed === "/event week") {
    const range = getRangeFromPreset("week");
    return getScheduleTextForRange(range.start, range.end, range.title, range.label);
  }

  if (trimmed === "/event nextweek") {
    const range = getRangeFromPreset("nextweek");
    return getScheduleTextForRange(range.start, range.end, range.title, range.label);
  }

  if (trimmed === "/event month") {
    const range = getRangeFromPreset("month");
    return getScheduleTextForRange(range.start, range.end, range.title, range.label);
  }

  if (trimmed === "/event nextmonth") {
    const range = getRangeFromPreset("nextmonth");
    return getScheduleTextForRange(range.start, range.end, range.title, range.label);
  }

  if (trimmed === "/card today") {
    if (!canRequestSummary(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ขอการ์ดสรุปงานครับ";
    }
    return createScheduleCard(input.lineUserId, input.user.id);
  }

  if (trimmed === "/summary today") {
    if (!canRequestSummary(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ดูสรุปงานครับ";
    }
    const range = getRangeFromPreset("today");
    return getSummaryTextForRange(range.start, range.end, "สรุปงานวันนี้", range.label);
  }

  if (trimmed === "/summary tomorrow") {
    if (!canRequestSummary(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ดูสรุปงานครับ";
    }
    const range = getRangeFromPreset("tomorrow");
    return getSummaryTextForRange(range.start, range.end, "สรุปงานพรุ่งนี้", range.label);
  }

  if (trimmed === "/summary dayaftertomorrow") {
    if (!canRequestSummary(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ดูสรุปงานครับ";
    }
    const range = getRangeFromPreset("dayaftertomorrow");
    return getSummaryTextForRange(range.start, range.end, "สรุปงานมะรืน", range.label);
  }

  if (trimmed === "/summary week") {
    if (!canRequestSummary(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ดูสรุปงานครับ";
    }
    const range = getRangeFromPreset("week");
    return getSummaryTextForRange(range.start, range.end, "สรุปงานสัปดาห์นี้", range.label);
  }

  if (trimmed === "/summary nextweek") {
    if (!canRequestSummary(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ดูสรุปงานครับ";
    }
    const range = getRangeFromPreset("nextweek");
    return getSummaryTextForRange(range.start, range.end, "สรุปงานสัปดาห์หน้า", range.label);
  }

  if (trimmed === "/summary month") {
    if (!canRequestSummary(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ดูสรุปงานครับ";
    }
    const range = getRangeFromPreset("month");
    return getSummaryTextForRange(range.start, range.end, "สรุปงานเดือนนี้", range.label);
  }

  if (trimmed === "/summary nextmonth") {
    if (!canRequestSummary(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ดูสรุปงานครับ";
    }
    const range = getRangeFromPreset("nextmonth");
    return getSummaryTextForRange(range.start, range.end, "สรุปงานเดือนหน้า", range.label);
  }

  const clarifyDayMatch = trimmed.match(/^\/clarify day\s*\|\s*(.+)$/i);
  if (clarifyDayMatch) {
    return `📌 ต้องการให้ผมดูตารางหรือเพิ่มกิจกรรมใน "${clarifyDayMatch[1].trim()}" ครับ\n\nตัวอย่าง:\n- ตาราง ${clarifyDayMatch[1].trim()}\n- ${clarifyDayMatch[1].trim()} 0800 ไปงานแต่งนะ`;
  }

  const eventRangeMatch = trimmed.match(/^\/event range\s*\|\s*([^|]+)\|\s*(.+)$/i);
  if (eventRangeMatch) {
    const start = parseDateInput(eventRangeMatch[1].trim(), false);
    const end = parseDateInput(eventRangeMatch[2].trim(), true);
    if (!start || !end) {
      return "⚠️ ช่วงวันที่ยังไม่ถูกต้องครับ ใช้รูปแบบเช่น 2026-04-01 ถึง 2026-04-30";
    }
    return getScheduleTextForRange(start, end, "ตารางงานตามช่วงเวลา", `${formatThaiDate(start)} - ${formatThaiDate(end)}`);
  }

  const summaryRangeMatch = trimmed.match(/^\/summary range\s*\|\s*([^|]+)\|\s*(.+)$/i);
  if (summaryRangeMatch) {
    if (!canRequestSummary(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ดูสรุปงานครับ";
    }
    const start = parseDateInput(summaryRangeMatch[1].trim(), false);
    const end = parseDateInput(summaryRangeMatch[2].trim(), true);
    if (!start || !end) {
      return "⚠️ ช่วงวันที่ยังไม่ถูกต้องครับ ใช้รูปแบบเช่น 2026-04-01 ถึง 2026-04-30";
    }
    return getSummaryTextForRange(start, end, "สรุปงานตามช่วงเวลา", `${formatThaiDate(start)} - ${formatThaiDate(end)}`);
  }

  const addMatch = trimmed.match(
    /^\/event add\s*\|\s*(.+?)\s*\|\s*([^|]+)\s*\|\s*([^|]+)(?:\|\s*([^|]+))?(?:\|\s*(.+))?$/i
  );
  if (addMatch) {
    if (!canManageCalendar(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์เพิ่มกิจกรรมในปฏิทินกลางครับ";
    }
    return createCalendarEventFromCommand({
      title: addMatch[1].trim(),
      startAt: addMatch[2].trim(),
      endAt: addMatch[3].trim(),
      locationType: addMatch[4]?.trim() ?? "INTERNAL",
      locationDisplayName: addMatch[5]?.trim() ?? null,
      createdBy: "line_command"
    });
  }

  const quickEventMatch = trimmed.match(/^\/event quick\s*\|\s*(.+)$/i);
  if (quickEventMatch) {
    if (!canManageCalendar(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์เพิ่มกิจกรรมในปฏิทินกลางครับ";
    }

    try {
      const quickEvent = JSON.parse(quickEventMatch[1]) as QuickEventPayload;

      return createCalendarEventFromCommand({
        title: quickEvent.title,
        startAt: quickEvent.startAt,
        endAt: quickEvent.endAt,
        locationType: "OUTSIDE",
        locationDisplayName: quickEvent.locationDisplayName ?? undefined,
        description: quickEvent.description ?? null,
        dressCode: quickEvent.dressCode ?? null,
        note: quickEvent.note ?? null,
        taskDetails: quickEvent.taskDetails ?? null,
        createdBy: "line_quick_action"
      });
    } catch {
      return "⚠️ ระบบแปลงคำสั่งตารางด่วนไม่สำเร็จครับ ลองใช้รูปแบบใหม่อีกครั้ง";
    }
  }

  const deleteMatch = trimmed.match(/^\/event delete\s*\|\s*(.+)$/i);
  if (deleteMatch) {
    if (!canManageCalendar(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ลบกิจกรรมในปฏิทินกลางครับ";
    }
    return deleteCalendarEventByKeyword(deleteMatch[1].trim());
  }

  const staffMatch = trimmed.match(/^\/staff send\s*\|\s*([^|]+)\|\s*(.+)$/i);
  if (staffMatch) {
    if (!canMessageStaff(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ส่งข้อความสั่งงานให้ทีมครับ";
    }
    return sendStaffMessage({
      senderUserId: input.user.id,
      senderRole: input.user.role,
      target: staffMatch[1].trim(),
      message: staffMatch[2].trim(),
      lineUserId: input.lineUserId
    });
  }

  const staffFileMatch =
    trimmed.match(/^ส่งไฟล์นี้ให้\s+(.+?)\s+(.+)$/i) ??
    trimmed.match(/^(.+?\.[a-z0-9]{2,6})\s+ส่งไฟล์นี้ให้\s+(.+?)\s+(.+)$/i);
  if (staffFileMatch && (fileContextCache.has(input.lineUserId) || (await getLatestUploadedFileForLineUser(input.lineUserId)))) {
    if (!canMessageStaff(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ส่งไฟล์พร้อมสั่งงานให้ทีมครับ";
    }

    const requestedFileName = staffFileMatch.length === 4 ? staffFileMatch[1].trim() : null;
    const target = staffFileMatch.length === 4 ? staffFileMatch[2].trim() : staffFileMatch[1].trim();
    const message = staffFileMatch.length === 4 ? staffFileMatch[3].trim() : staffFileMatch[2].trim();

    return sendStaffMessage({
      senderUserId: input.user.id,
      senderRole: input.user.role,
      target,
      message,
      includeCachedFile: true,
      lineUserId: input.lineUserId,
      requestedFileName
    });
  }

  return null;
}

async function handleBinaryUpload(
  event: WebhookEvent & { type: "message"; message: { id: string; type: "image" | "file"; fileName?: string } },
  user: { id: string | null; role: string },
  lineUserId: string
) {
  const fileStream = await getLineClient().getMessageContent(event.message.id);
  const fileBuffer = await readStreamToBuffer(fileStream);
  const isImage = event.message.type === "image";
  const originalFileName = isImage
    ? `upload_${Date.now()}.jpg`
    : event.message.fileName ?? `file_${Date.now()}`;
  const mimeType = isImage ? "image/jpeg" : "application/octet-stream";

  const storedLocalFile = await saveIncomingFileToDisk({
    buffer: fileBuffer,
    originalFileName,
    mimeType,
    role: user.role
  });

  const fileRecord = await createUploadedFileRecord({
    userId: user.id,
    lineUserId,
    lineMessageId: event.message.id,
    sourceProvider: "line",
    fileName: originalFileName,
    mimeType,
    local: storedLocalFile
  });

  let driveResult: { id: string; webViewLink: string | null } | null = null;
  let driveSyncNotice = "";

  try {
    driveResult = await uploadFileToDrive({
      fileName: originalFileName,
      mimeType,
      fileStream: bufferToReadable(fileBuffer),
      folderId: getDriveFolderId(user.role, mimeType)
    });

    await markUploadedFileDriveSynced({
      id: fileRecord.id,
      driveFileId: driveResult.id,
      driveUrl: driveResult.webViewLink
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Google Drive sync failure";
    await markUploadedFileDriveFailed({
      id: fileRecord.id,
      errorMessage: message
    });
    driveSyncNotice =
      "\n\n⚠️ สำเนาบนเซิร์ฟเวอร์ถูกบันทึกแล้ว แต่การ sync ไป Google Drive ยังไม่สำเร็จในรอบนี้";
  }

  fileContextCache.set(lineUserId, {
    fileRecordId: fileRecord.id,
    fileName: originalFileName,
    originalFileName,
    fileUrl: driveResult?.webViewLink ?? storedLocalFile.publicUrl ?? "",
    localUrl: storedLocalFile.publicUrl,
    localPath: storedLocalFile.absolutePath,
    mimeType,
    timestamp: Date.now()
  });

  const response = isImage
    ? `✅ บันทึกรูปภาพเรียบร้อยครับ\n\n💾 Server Copy: ${storedLocalFile.publicUrl ?? storedLocalFile.publicPath}${driveResult?.webViewLink ? `\n📎 Google Drive: ${driveResult.webViewLink}` : ""}${driveSyncNotice}\n\n💡 ใช้คำสั่ง "ส่งไฟล์นี้ให้ [ชื่อ] [ข้อความ]" เพื่อส่งต่อได้เลย`
    : `✅ บันทึกไฟล์ "${originalFileName}" เรียบร้อยครับ\n\n💾 Server Copy: ${storedLocalFile.publicUrl ?? storedLocalFile.publicPath}${driveResult?.webViewLink ? `\n📎 Google Drive: ${driveResult.webViewLink}` : ""}${driveSyncNotice}\n\n💡 ใช้คำสั่ง "ส่งไฟล์นี้ให้ [ชื่อ] [ข้อความ]" เพื่อส่งต่อได้เลย`;

  await replyText(event.replyToken, response);
}

async function handleTextMessage(event: WebhookEvent & { type: "message"; message: { type: "text"; text: string } }) {
  const lineUserId = event.source.userId;
  if (!lineUserId) {
    return;
  }

  const user = await ensureLineUser(lineUserId);
  const text = event.message.text;
  const trimmed = text.trim();
  const aiModeActive = isAIModeActive(lineUserId);

  if (user.role === "GUEST") {
    const guestMessage =
      "⚠️ ขออภัยครับ ระบบยังไม่รู้จักคุณในฐานะพนักงาน กรุณาให้ Admin กำหนดสิทธิ์ให้ในระบบก่อนครับ";
    await logConversation(lineUserId, user.id, text, guestMessage);
    await replyText(event.replyToken, guestMessage);
    return;
  }

  if (isExitAICommand(trimmed)) {
    clearAIMode(lineUserId);
    const message = "✅ ออกจาก AI Mode แล้วครับ\n\nตอนนี้ระบบกลับมาใช้ Quick Action ตามปกติแล้ว";
    await logConversation(lineUserId, user.id, text, message);
    await replyText(event.replyToken, message, {
      title: "AI Mode",
      accentColor: "#7c3aed"
    });
    return;
  }

  if (isAIInvocation(trimmed)) {
    const prompt = trimmed.replace(/^ai\s*/i, "").trim();
    enterAIMode(lineUserId);

    if (!prompt) {
      const message =
        "🤖 เข้าสู่ AI Mode แล้วครับ\n\nพิมพ์คำถามหรือคำสั่งที่ต้องการได้เลย และเมื่อต้องการออกให้กด Exit หรือพิมพ์ exit";
      await logConversation(lineUserId, user.id, text, message);
      await replyText(event.replyToken, message, {
        title: "AI Mode",
        accentColor: "#7c3aed",
        quickReplyExit: true
      });
      return;
    }

    const result = await requestGatewayChat({
      prompt,
      policy: config.KOYEB0_DEFAULT_POLICY,
      context: `${buildRoleContext(user)}\nYou are in explicit AI mode. Answer helpfully in Thai.`,
      metadata: {
        source: "line_ai_mode",
        lineUserId,
        role: user.role
      }
    });

    const answer = result.text || "ขออภัยครับ ตอนนี้ยังไม่สามารถตอบได้";
    await logConversation(lineUserId, user.id, text, answer);
    await replyText(event.replyToken, answer, {
      title: "AI Mode",
      accentColor: "#7c3aed",
      quickReplyExit: true
    });
    return;
  }

  if (aiModeActive) {
    refreshAIMode(lineUserId);
    const result = await requestGatewayChat({
      prompt: trimmed,
      policy: config.KOYEB0_DEFAULT_POLICY,
      context: `${buildRoleContext(user)}\nYou are in explicit AI mode. Answer helpfully in Thai.`,
      metadata: {
        source: "line_ai_mode",
        lineUserId,
        role: user.role
      }
    });

    const answer = result.text || "ขออภัยครับ ตอนนี้ยังไม่สามารถตอบได้";
    await logConversation(lineUserId, user.id, text, answer);
    await replyText(event.replyToken, answer, {
      title: "AI Mode",
      accentColor: "#7c3aed",
      quickReplyExit: true
    });
    return;
  }

  const commandResult = await tryHandleCommand({
    text,
    user: {
      id: user.id,
      role: user.role
    },
    lineUserId
  });

  if (commandResult) {
    await logConversation(lineUserId, user.id, text, commandResult);
    await replyText(event.replyToken, commandResult);
    return;
  }

  const fallbackMessage = isResearchRequest(text)
    ? "🔎 ถ้าต้องการใช้ AI เพื่อค้นข้อมูลหรือสรุปผล กรุณาพิมพ์ขึ้นต้นด้วย AI เช่น\nAI ช่วยสรุปงานสัปดาห์นี้แบบผู้บริหาร"
    : "💡 ระบบนี้ใช้ Quick Action เป็นหลักครับ\n\nถ้าต้องการคุยกับ AI โดยตรง ให้พิมพ์ขึ้นต้นด้วย AI เช่น\nAI ช่วยร่างข้อความสั่งงานให้เลขา";
  await logConversation(lineUserId, user.id, text, fallbackMessage);
  await replyText(event.replyToken, fallbackMessage, {
    title: "Quick Action",
    accentColor: "#2563eb"
  });
}

export async function handleLineEvent(event: WebhookEvent): Promise<void> {
  await logWebhookEvent(event, "received");

  if (event.type === "message" && event.message.type === "text") {
    await handleTextMessage(event as WebhookEvent & { type: "message"; message: { type: "text"; text: string } });
    await logWebhookEvent(event, "processed");
    return;
  }

  if (
    event.type === "message" &&
    (event.message.type === "image" || event.message.type === "file") &&
    event.source.userId
  ) {
    const user = await ensureLineUser(event.source.userId);
    await handleBinaryUpload(
      event as WebhookEvent & { type: "message"; message: { id: string; type: "image" | "file"; fileName?: string } },
      { id: user.id, role: user.role },
      event.source.userId
    );
    await logWebhookEvent(event, "processed");
    return;
  }

  if (event.type === "follow" && event.source.userId) {
    await ensureLineUser(event.source.userId);
    await logWebhookEvent(event, "processed");
    return;
  }

  await logWebhookEvent(event, "ignored");
}
