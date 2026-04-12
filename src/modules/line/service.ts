import { Client, middleware, MiddlewareConfig, WebhookEvent } from "@line/bot-sdk";
import {
  acdcCommands,
  acdcRoleAliases,
  acdcRoleCapabilities,
  CommandDefinition,
  createCommandRegistry
} from "extension-koyeb";
import { NextFunction, Request, Response } from "express";
import { config } from "../../config";
import { supabaseAdmin } from "../../lib/supabase";
import { requestGatewayChat } from "../ai-gateway/client";
import { deleteFileFromDrive, uploadFileToDrive } from "../drive/service";
import {
  canManageCalendar,
  canManageFilePurge,
  canMessageStaff,
  canReceiveAcknowledgement,
  canRequestAcknowledgement,
  canRequestSummary,
  canSendFileForReview,
  canUseAIMode,
  isSecretaryRole,
  normalizeCapabilityRole,
  requiresSecretaryReview
} from "../policy/role-capabilities";
import {
  bufferToReadable,
  createUploadedFileRecord,
  deleteUploadedFileRecord,
  extractUploadedFilePreview,
  getAllUploadedFilesForLineUser,
  getUploadedFileById,
  getLatestUploadedFileForLineUser,
  getRecentUploadedFilesForLineUser,
  markUploadedFileDriveFailed,
  markUploadedFileDriveSynced,
  readStreamToBuffer,
  removeExtractionSidecar,
  removeStoredFileArtifacts,
  saveIncomingFileToDisk,
  updateUploadedFileReviewState
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

const roleKeywordMap = new Map<string, string>([
  ["นยก", "NYK"],
  ["นายทหารยุทธการ", "NYK"],
  ["นกบ", "NKB"],
  ["นายทหารส่งกำลังบำรุง", "NKB"],
  ["นกพ", "NPK"],
  ["นายทหารกำลังพล", "NPK"],
  ["นกง", "NNG"],
  ["นายทหารการเงิน", "NNG"],
  ["เลขา", "SECRETARY"],
  ["ผู้ช่วย", "SECRETARY"],
  ["หน้าห้อง", "SECRETARY"],
  ["ผู้ช่วยผู้พัน", "SECRETARY"],
  ["ผช.", "SECRETARY"],
  ["ผช", "SECRETARY"],
  ["secretary", "SECRETARY"],
  ["ผู้พัน", "BOSS"],
  ["บอส", "BOSS"],
  ["boss", "BOSS"],
  ["ผบ.พัน", "BOSS"],
  ["ผบพัน", "BOSS"],
  ["ผบ พัน", "BOSS"],
  ["dev", "DEV"],
  ["developer", "DEV"],
  ["ผู้พัฒนา", "DEV"]
]);
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
const pendingRejectReviewState = new Map<string, { fileId: string; requesterUserId: string | null }>();
const pendingFilePurgeState = new Map<string, { scope: "meta" | "all"; count: number }>();
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

const extensionCommandRegistry = createCommandRegistry({
  commands: acdcCommands,
  roleAliases: acdcRoleAliases,
  roleCapabilities: acdcRoleCapabilities
});

const extensionMenuLabels: Partial<Record<CommandDefinition["key"], string>> = {
  "help.menu": "/help หรือ /commands หรือ /menu หรือ /สิทธิ์",
  "help.ai": "/help ai",
  "help.files": "/help files",
  "system.status": "/status",
  "system.clear": "/clear",
  "files.status": "/files status",
  "files.clear-meta": "/files clear-meta",
  "files.clear-all": "/files clear-all",
  "calendar.today": "ตารางงานวันนี้ / มีงานอะไรวันนี้",
  "calendar.tomorrow": "ตารางพรุ่งนี้ / มีงานอะไรพรุ่งนี้",
  "summary.today": "สรุปงานวันนี้",
  "summary.nextweek": "สรุปงานสัปดาห์หน้า",
  "summary.thismonth": "สรุปงานเดือนนี้",
  "ai.explicit": "AI ...",
  "messaging.staff": "ส่งข้อความให้... / ฝากข้อความให้...",
  "files.forward": "ส่งไฟล์นี้ให้... [ข้อความ]",
  "ack.request": "เรียก นยก / นกบ / นกพ / นกง"
};

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

type UploadSuccessCardInput = {
  title: string;
  isImage: boolean;
  openUrl: string;
  driveUrl?: string | null;
  driveFailed?: boolean;
};

type AcknowledgementAction = "acknowledged" | "outside";

type AcknowledgementRequestInput = {
  requestId: string;
  requesterRole: string;
  requesterDisplayName: string;
  targetDisplayName: string;
};

type FileReviewAction = "approve" | "reject";

type FileReviewRequestInput = {
  fileId: string;
  fileName: string;
  senderRole: string;
  senderDisplayName: string;
  instruction: string;
  openUrl: string;
  driveUrl?: string | null;
};

type RolePersonaRow = {
  role: string;
  greeting?: string | null;
  tone?: string | null;
  behavior?: string | null;
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

function getAiModeExpiresAt(lineUserId: string): number | null {
  const expiresAt = aiModeState.get(lineUserId);
  if (!expiresAt || expiresAt <= Date.now()) {
    return null;
  }
  return expiresAt;
}

function clearTransientUserState(lineUserId: string): void {
  clearAIMode(lineUserId);
  fileContextCache.delete(lineUserId);
  pendingRejectReviewState.delete(lineUserId);
}

function normalizeHelpRole(role: string): string {
  return resolveRoleKeyword(role) ?? String(normalizeCapabilityRole(role));
}

function getRoleDisplayName(role: string): string {
  switch (normalizeHelpRole(role)) {
    case "DEV":
      return "DEV";
    case "BOSS":
      return "BOSS / ผู้พัน";
    case "SECRETARY":
      return "SECRETARY / เลขา";
    case "NYK":
      return "NYK / นยก";
    case "NKB":
      return "NKB / นกบ";
    case "NPK":
      return "NPK / นกพ";
    case "NNG":
      return "NNG / นกง";
    case "GUEST":
      return "GUEST";
    default:
      return normalizeHelpRole(role);
  }
}

function buildRoleMenuText(role: string): string {
  const normalizedRole = normalizeHelpRole(role);

  if (normalizedRole === "GUEST") {
    return [
      "สิทธิ์ของคุณ: GUEST",
      "",
      "ตอนนี้ยังไม่มีสิทธิ์ใช้งานระบบครับ",
      "กรุณาให้ DEV กำหนด role ให้ก่อน"
    ].join("\n");
  }

  const lines = [
    `สิทธิ์ของคุณ: ${getRoleDisplayName(normalizedRole)}`,
    "",
    "คำสั่งที่ใช้ได้"
  ];

  const availableCommands = extensionCommandRegistry.listForRole(normalizedRole);
  const menuLines = new Set<string>();

  for (const command of availableCommands) {
    const label = extensionMenuLabels[command.key];
    if (label) {
      menuLines.add(`- ${label}`);
    }
  }

  for (const line of menuLines) {
    lines.push(line);
  }

  if (canManageCalendar(normalizedRole)) {
    lines.push("- ตารางงานอังคารหน้า");
  }

  if (canRequestSummary(normalizedRole)) {
    lines.push("- ขอการ์ดวันนี้");
  }

  if (canManageFilePurge(normalizedRole)) {
    lines.push("- /help role BOSS");
  }

  lines.push("", "ข้อจำกัด");

  switch (normalizedRole) {
    case "DEV":
      lines.push("- DEV ดูแลระบบและล้างไฟล์ทั้งชุดได้");
      break;
    case "BOSS":
      lines.push("- เปลี่ยน role DEV ไม่ได้");
      lines.push("- เปลี่ยนคนที่เป็น BOSS ไม่ได้");
      break;
    case "SECRETARY":
      lines.push("- เปลี่ยน role BOSS / DEV / SECRETARY ไม่ได้");
      break;
    case "NYK":
    case "NKB":
    case "NPK":
    case "NNG":
      lines.push("- ใช้ AI ไม่ได้");
      lines.push("- ใช้ได้เฉพาะ quick action และ workflow ที่ได้รับมอบหมาย");
      break;
    default:
      lines.push("- ระบบจะจำกัดตามบทบาทที่ได้รับ");
      break;
  }

  return lines.join("\n");
}

function buildAiHelpText(role: string): string {
  const normalizedRole = normalizeHelpRole(role);
  const lines = [
    "คู่มือ AI Mode",
    "",
    "วิธีใช้",
    "- พิมพ์ขึ้นต้นด้วย AI เช่น AI ช่วยร่างข้อความประสานงานให้เลขา",
    "- พิมพ์ exit เพื่อออกจาก AI Mode",
    "",
    "ข้อควรรู้",
    "- ตารางงานและสรุปงานบางแบบจะถูก route ไป Quick Action ก่อน",
    "- AI จะไม่เดาฐานข้อมูลถ้ายังไม่มีข้อมูลที่ยืนยันได้"
  ];

  if (!canUseAIMode(normalizedRole)) {
    lines.push("", "บทบาทนี้ยังไม่เปิด AI Mode ครับ");
  }

  return lines.join("\n");
}

function buildFilesHelpText(role: string): string {
  const normalizedRole = normalizeHelpRole(role);
  const lines = [
    "คู่มือไฟล์",
    "",
    "คำสั่งหลัก",
    "- ส่งไฟล์เข้ามาใน LINE เพื่อบันทึกลงระบบ",
    "- ส่งไฟล์นี้ให้ [ชื่อ] [ข้อความ] เพื่อส่งต่อไฟล์พร้อมคำสั่งงาน",
    "",
    "AI-on-file",
    "- AI ช่วยสรุปไฟล์ล่าสุด",
    "- AI ช่วยบอกเนื้อหาเบื้องต้นของเอกสารล่าสุด"
  ];

  if (canManageFilePurge(normalizedRole)) {
    lines.push("", "คำสั่งสำหรับ DEV");
    lines.push("- /files status");
    lines.push("- /files clear-meta");
    lines.push("- /files clear-all");
  }

  lines.push("", "หมายเหตุ");
  lines.push("- clear-meta จะลบ metadata และ sidecar OCR");
  lines.push("- clear-all จะลบ metadata, local file, sidecar และพยายามลบไฟล์ใน Drive");

  return lines.join("\n");
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

function inferMimeTypeFromFileName(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const byExtension: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp"
  };

  return byExtension[ext] ?? "application/octet-stream";
}

function resolveDayExpression(dayInput: string, now = new Date()): BangkokDateParts | null {
  const trimmed = dayInput.trim().toLowerCase();
  const baseParts = getBangkokDateParts(now);
  const base = toBangkokDateObject(baseParts);

  if (trimmed === "เมื่อวาน") {
    const date = new Date(base);
    date.setUTCDate(date.getUTCDate() - 1);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate()
    };
  }

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

function formatBangkokDateForQuery(date: Date): string {
  const parts = getBangkokDateTimeParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function buildCalendarQrUrl(date: Date): string {
  const rawBaseUrl = config.DASHBOARD_CARD_URL ?? config.NEXTJS_FRONTEND_URL ?? "https://example.com";

  try {
    const url = new URL(rawBaseUrl);
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = "/calendar";
    }
    url.searchParams.set("date", formatBangkokDateForQuery(date));
    return url.toString();
  } catch {
    return rawBaseUrl;
  }
}

type DateRangePreset = {
  start: Date;
  end: Date;
  label: string;
  title: string;
};

function getRangeForDayExpression(dayInput: string, titlePrefix: string): DateRangePreset | null {
  const parts = resolveDayExpression(dayInput);
  if (!parts) {
    return null;
  }

  const start = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, -7, 0, 0, 0));
  const end = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 16, 59, 59, 999));
  return {
    start,
    end,
    label: `ประจำวัน ${formatThaiDate(start)}`,
    title: `${titlePrefix}${dayInput.trim()}`
  };
}

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
  owner_user_id?: string | null;
  created_by?: string | null;
  created_at?: string | null;
};

async function getPrimaryBossUserId(): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("role", "BOSS")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.id ?? null;
}

async function resolveDefaultEventOwnerUserId(input: {
  actorUserId: string | null;
  actorRole: string;
}): Promise<string | null> {
  const normalizedRole = input.actorRole.toUpperCase();

  if (normalizedRole === "BOSS") {
    return input.actorUserId ?? (await getPrimaryBossUserId());
  }

  if (normalizedRole === "SECRETARY") {
    return await getPrimaryBossUserId();
  }

  return input.actorUserId ?? null;
}

function buildEventCreatedByLabel(input: {
  source: "line_command" | "line_quick_action";
  actorRole: string;
  actorDisplayName?: string | null;
}): string {
  const display = input.actorDisplayName?.trim();
  const base = `${input.source}:${input.actorRole.toUpperCase()}`;
  return display ? `${base}:${display}` : base;
}

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

function normalizeCompactThai(text: string): string {
  return text.trim().replace(/\s+/g, "");
}

function normalizeCommonThaiTypos(text: string): string {
  return text
    .replace(/ตารางาน/g, "ตารางงาน")
    .replace(/ตารางงาน/g, "ตารางงาน");
}

function stripThaiPoliteness(text: string): string {
  return text
    .trim()
    .replace(/(หน่อย|ที|ทีนะ|ทีครับ|ทีคะ|ทีค่ะ|นะ|นะครับ|นะคะ|นะค่ะ|ครับ|คะ|ค่ะ|ด้วย|ให้หน่อย|ให้ที)$/i, "")
    .trim();
}

function buildDateIntentRegex(
  dateToken: string,
  options?: { requireSummary?: boolean }
): RegExp {
  const summaryPrefix = options?.requireSummary ? "(?:ขอ|ช่วย)?สรุป(?:รายงาน)?งาน" : "(?:(?:ขอ|ช่วย)?ดู)?(?:ตาราง|ตารางงาน|งาน)?";
  return new RegExp(
    `^(?:${summaryPrefix})?(?:มี)?(?:อะไร)?(?:ที่ต้องทำ)?${dateToken}(?:มีอะไรบ้าง|ล่ะ|บ้าง)?(?:หน่อย|ที|นะ|ครับ|คะ|ค่ะ)?$`,
    "i"
  );
}

function matchesScheduleIntent(text: string, dateToken: string): boolean {
  const trimmed = stripThaiPoliteness(text);
  const compact = normalizeCompactThai(trimmed);
  return (
    trimmed === `ตาราง${dateToken}` ||
    trimmed === `ตารางงาน${dateToken}` ||
    trimmed === `ดูตาราง${dateToken}` ||
    trimmed === `ดูตารางงาน${dateToken}` ||
    trimmed === `งาน${dateToken}` ||
    trimmed === `${dateToken}มีงานอะไรบ้าง` ||
    trimmed === `มีงานอะไร${dateToken}` ||
    trimmed === `มีตารางอะไร${dateToken}` ||
    trimmed === `มีอะไร${dateToken}บ้าง` ||
    new RegExp(`^ตารางของ.*${dateToken}$`, "i").test(trimmed) ||
    buildDateIntentRegex(dateToken).test(compact)
  );
}

function matchesSummaryIntent(text: string, dateToken: string): boolean {
  const trimmed = stripThaiPoliteness(text);
  const compact = normalizeCompactThai(trimmed);
  return (
    trimmed === `สรุปงาน${dateToken}` ||
    trimmed === `รายงาน${dateToken}` ||
    trimmed === `ช่วยสรุปงาน${dateToken}` ||
    trimmed === `ขอสรุปงาน${dateToken}` ||
    trimmed === `${dateToken}สรุปงาน` ||
    buildDateIntentRegex(dateToken, { requireSummary: true }).test(compact)
  );
}

function resolveRoleKeyword(target: string): string | null {
  const normalized = target.trim().toLowerCase();
  return roleKeywordMap.get(normalized) ?? null;
}

function normalizeTextCommand(text: string): string {
  const trimmed = normalizeCommonThaiTypos(text.trim());
  const compact = normalizeCompactThai(trimmed);

  if (/^(เมื่อวาน|วันนี้|พรุ่งนี้|มะรืน|(?:วัน)?(?:จันทร์|อังคาร|พุธ|พฤหัส|พฤหัสบดี|ศุกร์|เสาร์|อาทิตย์)(?:นี้|หน้า)?)$/i.test(trimmed)) {
    return `/clarify day | ${trimmed}`;
  }

  const genericScheduleDayMatch = trimmed.match(
    /^(?:ขอ|ช่วย)?(?:ดู)?(?:ตาราง|ตารางงาน|งาน)\s*((?:เมื่อวาน|วันนี้|พรุ่งนี้|มะรืน|(?:วัน)?(?:จันทร์|อังคาร|พุธ|พฤหัส|พฤหัสบดี|ศุกร์|เสาร์|อาทิตย์)(?:นี้|หน้า)?))$/i
  );
  if (genericScheduleDayMatch && resolveDayExpression(genericScheduleDayMatch[1].trim())) {
    return `/event day | ${genericScheduleDayMatch[1].trim()}`;
  }

  const genericSummaryDayMatch = trimmed.match(
    /^(?:ขอ|ช่วย)?(?:สรุปงาน|รายงาน)\s*((?:เมื่อวาน|วันนี้|พรุ่งนี้|มะรืน|(?:วัน)?(?:จันทร์|อังคาร|พุธ|พฤหัส|พฤหัสบดี|ศุกร์|เสาร์|อาทิตย์)(?:นี้|หน้า)?))$/i
  );
  if (genericSummaryDayMatch && resolveDayExpression(genericSummaryDayMatch[1].trim())) {
    return `/summary day | ${genericSummaryDayMatch[1].trim()}`;
  }

  if (matchesScheduleIntent(trimmed, "วันนี้")) {
    return "/event today";
  }

  if (matchesScheduleIntent(trimmed, "เมื่อวาน")) {
    return "/event day | เมื่อวาน";
  }

  if (matchesScheduleIntent(trimmed, "พรุ่งนี้")) {
    return "/event tomorrow";
  }

  if (matchesScheduleIntent(trimmed, "มะรืน")) {
    return "/event dayaftertomorrow";
  }

  if (matchesScheduleIntent(trimmed, "สัปดาห์นี้") || trimmed === "สัปดาห์นี้ล่ะ") {
    return "/event week";
  }

  if (matchesScheduleIntent(trimmed, "สัปดาห์หน้า")) {
    return "/event nextweek";
  }

  if (matchesScheduleIntent(trimmed, "เดือนนี้")) {
    return "/event month";
  }

  if (matchesScheduleIntent(trimmed, "เดือนหน้า")) {
    return "/event nextmonth";
  }

  if (matchesSummaryIntent(trimmed, "วันนี้")) {
    return "/summary today";
  }

  if (matchesSummaryIntent(trimmed, "เมื่อวาน")) {
    return "/summary day | เมื่อวาน";
  }

  if (matchesSummaryIntent(trimmed, "พรุ่งนี้")) {
    return "/summary tomorrow";
  }

  if (matchesSummaryIntent(trimmed, "มะรืน")) {
    return "/summary dayaftertomorrow";
  }

  if (matchesSummaryIntent(trimmed, "สัปดาห์นี้")) {
    return "/summary week";
  }

  if (matchesSummaryIntent(trimmed, "สัปดาห์หน้า")) {
    return "/summary nextweek";
  }

  if (matchesSummaryIntent(trimmed, "เดือนนี้")) {
    return "/summary month";
  }

  if (matchesSummaryIntent(trimmed, "เดือนหน้า")) {
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

  const staffNaturalMatch =
    trimmed.match(/^ส่งข้อความ(?:หา|ให้)\s*(.+?)\s+ว่า\s+(.+)$/i) ??
    trimmed.match(/^ฝากข้อความ(?:หา|ให้)\s*(.+?)\s+ว่า\s+(.+)$/i) ??
    trimmed.match(/^บอก(?:หา|ให้)?\s*(.+?)\s+ว่า\s+(.+)$/i);
  if (staffNaturalMatch) {
    return `/staff send | ${staffNaturalMatch[1].trim()} | ${staffNaturalMatch[2].trim()}`;
  }

  const directStaffNaturalMatch =
    trimmed.match(/^ส่งข้อความ(?:หา|ให้)\s*(.+?)\s+(.+)$/i) ??
    trimmed.match(/^ฝากข้อความ(?:หา|ให้)\s*(.+?)\s+(.+)$/i) ??
    trimmed.match(/^ฝากบอก\s*(.+?)\s+(.+)$/i);
  if (
    directStaffNaturalMatch &&
    !/^(.+?)\s+ว่า$/i.test(trimmed) &&
    !/^ส่งข้อความให้(?:โรล|role)/i.test(trimmed)
  ) {
    return `/staff send | ${directStaffNaturalMatch[1].trim()} | ${directStaffNaturalMatch[2].trim()}`;
  }

  const roleStaffMatch = trimmed.match(/^ส่งข้อความให้(?:โรล|role)\s*(.+?)\s+ว่า\s+(.+)$/i);
  if (roleStaffMatch) {
    return `/staff send | ${roleStaffMatch[1].trim()} | ${roleStaffMatch[2].trim()}`;
  }

  const assignMatch = trimmed.match(/^ส่งงานให้\s*(.+?)\s+(.+)$/i);
  if (assignMatch) {
    return `/staff send | ${assignMatch[1].trim()} | ${assignMatch[2].trim()}`;
  }

  const summaryRangeNaturalMatch = trimmed.match(/^สรุปงานช่วง\s+(.+?)\s+ถึง\s+(.+)$/i);
  if (summaryRangeNaturalMatch) {
    return `/summary range | ${summaryRangeNaturalMatch[1].trim()} | ${summaryRangeNaturalMatch[2].trim()}`;
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
  const normalizedRole =
    role.toUpperCase() === "DEV"
      ? "ADMIN"
      : ["NYK", "NKB", "NPK", "NNG"].includes(role.toUpperCase())
        ? "USER"
        : role.toUpperCase();

  const roleRootMap: Record<string, string | undefined> = {
    BOSS: config.GOOGLE_DRIVE_BOSS_ROOT_FOLDER || config.GDRIVE_BOSS_ROOT,
    SECRETARY: config.GOOGLE_DRIVE_SECRETARY_ROOT_FOLDER || config.GDRIVE_SECRETARY_ROOT,
    ADMIN: config.GOOGLE_DRIVE_ADMIN_ROOT_FOLDER || config.GDRIVE_ADMIN_ROOT,
    USER: config.GOOGLE_DRIVE_USER_ROOT_FOLDER || config.GDRIVE_USER_ROOT,
    GUEST: config.GOOGLE_DRIVE_GUEST_ROOT_FOLDER || config.GDRIVE_GUEST_ROOT
  };

  const roleImageMap: Record<string, string | undefined> = {
    BOSS: config.GOOGLE_DRIVE_BOSS_IMAGE_FOLDER || config.GDRIVE_BOSS_PICTURE,
    SECRETARY: config.GOOGLE_DRIVE_SECRETARY_IMAGE_FOLDER || config.GDRIVE_SECRETARY_PICTURE,
    ADMIN: config.GOOGLE_DRIVE_ADMIN_IMAGE_FOLDER || config.GDRIVE_ADMIN_PICTURE,
    USER: config.GOOGLE_DRIVE_USER_IMAGE_FOLDER || config.GDRIVE_USER_PICTURE,
    GUEST: config.GOOGLE_DRIVE_GUEST_IMAGE_FOLDER || config.GDRIVE_GUEST_PICTURE
  };

  const roleFileMap: Record<string, string | undefined> = {
    BOSS: config.GOOGLE_DRIVE_BOSS_FILE_FOLDER,
    SECRETARY: config.GOOGLE_DRIVE_SECRETARY_FILE_FOLDER,
    ADMIN: config.GOOGLE_DRIVE_ADMIN_FILE_FOLDER,
    USER: config.GOOGLE_DRIVE_USER_FILE_FOLDER,
    GUEST: config.GOOGLE_DRIVE_GUEST_FILE_FOLDER
  };

  const roleDocMap: Record<string, string | undefined> = {
    BOSS: config.GOOGLE_DRIVE_BOSS_DOC_FOLDER || config.GDRIVE_BOSS_DOC,
    SECRETARY: config.GOOGLE_DRIVE_SECRETARY_DOC_FOLDER || config.GDRIVE_SECRETARY_DOC,
    ADMIN: config.GOOGLE_DRIVE_ADMIN_DOC_FOLDER || config.GDRIVE_ADMIN_DOC,
    USER: config.GOOGLE_DRIVE_USER_DOC_FOLDER || config.GDRIVE_USER_DOC,
    GUEST: config.GOOGLE_DRIVE_GUEST_DOC_FOLDER || config.GDRIVE_GUEST_DOC
  };

  const rolePdfMap: Record<string, string | undefined> = {
    BOSS: config.GOOGLE_DRIVE_BOSS_PDF_FOLDER || config.GDRIVE_BOSS_PDF,
    SECRETARY: config.GOOGLE_DRIVE_SECRETARY_PDF_FOLDER || config.GDRIVE_SECRETARY_PDF,
    ADMIN: config.GOOGLE_DRIVE_ADMIN_PDF_FOLDER || config.GDRIVE_ADMIN_PDF,
    USER: config.GOOGLE_DRIVE_USER_PDF_FOLDER || config.GDRIVE_USER_PDF,
    GUEST: config.GOOGLE_DRIVE_GUEST_PDF_FOLDER || config.GDRIVE_GUEST_PDF
  };

  const genericRoot =
    config.GOOGLE_DRIVE_ROOT_FOLDER || config.GDRIVE_ROOT;
  const genericImage =
    config.GOOGLE_DRIVE_IMAGE_FOLDER || config.GDRIVE_PICTURE;
  const genericFile = config.GOOGLE_DRIVE_FILE_FOLDER;
  const genericDoc = config.GOOGLE_DRIVE_DOC_FOLDER || config.GDRIVE_DOC;
  const genericPdf = config.GOOGLE_DRIVE_PDF_FOLDER || config.GDRIVE_PDF;

  if (mimeType.startsWith("image/")) {
    return (
      roleImageMap[normalizedRole] ??
      genericImage ??
      roleRootMap[normalizedRole] ??
      genericRoot
    );
  }

  if (mimeType.includes("pdf")) {
    return (
      rolePdfMap[normalizedRole] ??
      genericPdf ??
      roleFileMap[normalizedRole] ??
      roleRootMap[normalizedRole] ??
      genericFile ??
      genericRoot
    );
  }

  if (
    mimeType.includes("word") ||
    mimeType.includes("document") ||
    mimeType.includes("sheet") ||
    mimeType.includes("excel") ||
    mimeType.includes("presentation") ||
    mimeType.includes("powerpoint") ||
    mimeType === "text/plain"
  ) {
    return (
      roleDocMap[normalizedRole] ??
      genericDoc ??
      roleFileMap[normalizedRole] ??
      roleRootMap[normalizedRole] ??
      genericFile ??
      genericRoot
    );
  }

  return (
    roleFileMap[normalizedRole] ??
    genericFile ??
    roleRootMap[normalizedRole] ??
    genericRoot
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

function resolveUserDisplayName(user: {
  nickname?: string | null;
  line_display_name?: string | null;
  username?: string | null;
  role?: string | null;
}) {
  return user.nickname ?? user.line_display_name ?? user.username ?? user.role ?? "เจ้าหน้าที่";
}

function getAIDisabledMessage(role: string): string {
  const normalizedRole = String(normalizeCapabilityRole(role));

  if (normalizedRole === "GUEST") {
    return "⚠️ บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งาน AI กรุณาให้แอดมินกำหนดสิทธิ์ก่อนครับ";
  }

  if (canReceiveAcknowledgement(normalizedRole)) {
    return "⚠️ บทบาทนี้ใช้ได้เฉพาะ Quick Action สำหรับรับคำสั่ง รับไฟล์ ตอบรับ และส่งงานกลับเข้าระบบ ยังไม่เปิด AI Mode ครับ";
  }

  return "⚠️ บทบาทนี้ยังไม่ได้รับสิทธิ์ใช้งาน AI Mode ครับ";
}

function getRolePolicyHints(role: string): string[] {
  const normalizedRole = role.toUpperCase();

  if (normalizedRole === "BOSS") {
    return [
      "Respond like an executive aide supporting a battalion commander.",
      "Prefer concise, decision-ready summaries with direct next actions.",
      "When summarizing, highlight operational risk, blockers, and what needs approval."
    ];
  }

  if (normalizedRole === "SECRETARY") {
    return [
      "Respond like a highly reliable military secretary and coordinator.",
      "Emphasize scheduling accuracy, action tracking, and communication clarity.",
      "When drafting messages, keep them professional, structured, and ready to send."
    ];
  }

  if (normalizedRole === "ADMIN" || normalizedRole === "DEV") {
    return [
      "Respond like a developer and systems administrator for internal operations.",
      "Prioritize operational correctness, traceability, and configuration awareness.",
      "Be direct, factual, and explicit about system limits or risks."
    ];
  }

  if (normalizedRole === "USER") {
    return [
      "Respond as a helpful internal operations assistant.",
      "Keep explanations practical and easy to act on.",
      "Do not imply authority beyond the caller's own scope."
    ];
  }

  return [
    "Respond conservatively and respect role boundaries.",
    "Avoid implying permissions or authority the caller does not have."
  ];
}

function buildAcknowledgementFlexMessage(input: AcknowledgementRequestInput) {
  const actions = [
    {
      type: "button",
      style: "primary",
      color: "#15803d",
      action: {
        type: "postback" as const,
        label: "ทราบครับ",
        data: `ack|${input.requestId}|acknowledged`,
        displayText: "ทราบครับ"
      }
    },
    {
      type: "button",
      style: "secondary",
      action: {
        type: "postback" as const,
        label: "ขออภัยครับ ตอนนี้อยู่ด้านนอก",
        data: `ack|${input.requestId}|outside`,
        displayText: "ขออภัยครับ ตอนนี้อยู่ด้านนอก"
      }
    }
  ];

  return {
    type: "flex" as const,
    altText: `คำสั่งเรียกจาก ${input.requesterDisplayName}`,
    contents: {
      type: "bubble" as const,
      size: "giga",
      header: {
        type: "box" as const,
        layout: "vertical" as const,
        paddingAll: "16px",
        backgroundColor: "#1d4ed8",
        contents: [
          {
            type: "text" as const,
            text: "คำสั่งเรียก",
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
            text: `${input.requesterRole} เรียก ${input.targetDisplayName}`,
            wrap: true,
            weight: "bold",
            size: "md",
            color: "#111827"
          },
          {
            type: "text" as const,
            text: `ผู้เรียก: ${input.requesterDisplayName}`,
            wrap: true,
            size: "sm",
            color: "#475569"
          },
          {
            type: "separator" as const,
            margin: "sm"
          },
          {
            type: "text" as const,
            text: "กรุณาตอบรับสถานะเพื่อให้ระบบแจ้งกลับหาผู้พันทันที",
            wrap: true,
            size: "sm",
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

function buildFileReviewFlexMessage(input: FileReviewRequestInput) {
  const buttons: any[] = [
    {
      type: "button",
      style: "primary",
      color: "#2563eb",
      action: {
        type: "uri" as const,
        label: "เปิดไฟล์",
        uri: input.openUrl
      }
    },
    {
      type: "button",
      style: "primary",
      color: "#15803d",
      action: {
        type: "postback" as const,
        label: "อนุมัติ",
        data: `file-review|${input.fileId}|approve`,
        displayText: "อนุมัติไฟล์นี้"
      }
    },
    {
      type: "button",
      style: "secondary",
      action: {
        type: "postback" as const,
        label: "ปฏิเสธ",
        data: `file-review|${input.fileId}|reject`,
        displayText: "ปฏิเสธไฟล์นี้"
      }
    }
  ];

  if (input.driveUrl) {
    buttons.splice(1, 0, {
      type: "button",
      style: "secondary",
      action: {
        type: "uri" as const,
        label: "Google Drive",
        uri: input.driveUrl
      }
    });
  }

  return {
    type: "flex" as const,
    altText: `เอกสารรอเลขาตรวจ: ${input.fileName}`,
    contents: {
      type: "bubble" as const,
      size: "giga",
      header: {
        type: "box" as const,
        layout: "vertical" as const,
        paddingAll: "16px",
        backgroundColor: "#7c3aed",
        contents: [
          {
            type: "text" as const,
            text: "ไฟล์รอเลขาตรวจ",
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
            text: input.fileName,
            wrap: true,
            weight: "bold",
            size: "md",
            color: "#111827"
          },
          {
            type: "text" as const,
            text: `ผู้ส่ง: ${input.senderDisplayName} (${input.senderRole})`,
            wrap: true,
            size: "sm",
            color: "#475569"
          },
          {
            type: "separator" as const,
            margin: "sm"
          },
          {
            type: "text" as const,
            text: input.instruction,
            wrap: true,
            size: "sm",
            color: "#111827"
          },
          {
            type: "text" as const,
            text: "หากปฏิเสธ ระบบจะขอเหตุผลเพิ่มเติมทันที",
            wrap: true,
            size: "xs",
            color: "#64748b"
          }
        ]
      },
      footer: {
        type: "box" as const,
        layout: "vertical" as const,
        spacing: "sm",
        paddingAll: "16px",
        contents: buttons
      }
    }
  } as any;
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

function buildFilePurgeFlexMessage(input: {
  fileCount: number;
  latestFileName?: string | null;
}) {
  return {
    type: "flex" as const,
    altText: `จัดการไฟล์ที่อัปโหลด (${input.fileCount} รายการ)`,
    contents: {
      type: "bubble" as const,
      size: "giga",
      header: {
        type: "box" as const,
        layout: "vertical" as const,
        paddingAll: "16px",
        backgroundColor: "#1d4ed8",
        contents: [
          {
            type: "text" as const,
            text: "จัดการไฟล์ที่อัปโหลด",
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
            text: `พบไฟล์ของบัญชีนี้ ${input.fileCount} รายการ`,
            wrap: true,
            weight: "bold",
            size: "md",
            color: "#111827"
          },
          {
            type: "text" as const,
            text: input.latestFileName ? `ไฟล์ล่าสุด: ${input.latestFileName}` : "ยังไม่มีไฟล์ล่าสุดในระบบ",
            wrap: true,
            size: "sm",
            color: "#475569"
          },
          {
            type: "separator" as const,
            margin: "sm"
          },
          {
            type: "text" as const,
            text: "เลือกได้ทั้งล้าง metadata อย่างเดียว หรือ ล้างทั้งหมดจริง (รวม local file / sidecar / Drive ถ้ามี)",
            wrap: true,
            size: "sm",
            color: "#111827"
          }
        ]
      },
      footer: {
        type: "box" as const,
        layout: "vertical" as const,
        spacing: "sm",
        paddingAll: "16px",
        contents: [
          {
            type: "button" as const,
            style: "secondary" as const,
            action: {
              type: "postback" as const,
              label: "ล้าง Meta",
              data: "file-purge|meta|prepare",
              displayText: "/files clear-meta"
            }
          },
          {
            type: "button" as const,
            style: "primary" as const,
            color: "#b45309",
            action: {
              type: "postback" as const,
              label: "ล้างทั้งหมด",
              data: "file-purge|all|prepare",
              displayText: "/files clear-all"
            }
          }
        ]
      }
    }
  } as any;
}

function buildFilePurgeConfirmFlexMessage(input: {
  scope: "meta" | "all";
  fileCount: number;
}) {
  const isAll = input.scope === "all";
  return {
    type: "flex" as const,
    altText: `ยืนยัน${isAll ? "ล้างทั้งหมด" : "ล้าง metadata"}`,
    contents: {
      type: "bubble" as const,
      size: "giga",
      header: {
        type: "box" as const,
        layout: "vertical" as const,
        paddingAll: "16px",
        backgroundColor: isAll ? "#b91c1c" : "#92400e",
        contents: [
          {
            type: "text" as const,
            text: isAll ? "ยืนยันล้างทั้งหมด" : "ยืนยันล้าง metadata",
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
            text: `จะดำเนินการกับไฟล์ ${input.fileCount} รายการ`,
            wrap: true,
            weight: "bold",
            size: "md",
            color: "#111827"
          },
          {
            type: "text" as const,
            text: isAll
              ? "คำสั่งนี้จะลบ metadata, local file, sidecar OCR และจะพยายามลบไฟล์ใน Google Drive ด้วยถ้ามี drive_file_id"
              : "คำสั่งนี้จะลบ metadata ในฐานข้อมูลและ sidecar OCR แต่จะยังไม่แตะไฟล์จริงใน local disk หรือ Google Drive",
            wrap: true,
            size: "sm",
            color: "#111827"
          }
        ]
      },
      footer: {
        type: "box" as const,
        layout: "vertical" as const,
        spacing: "sm",
        paddingAll: "16px",
        contents: [
          {
            type: "button" as const,
            style: "primary" as const,
            color: isAll ? "#b91c1c" : "#92400e",
            action: {
              type: "postback" as const,
              label: "ยืนยัน",
              data: `file-purge|${input.scope}|confirm`,
              displayText: isAll ? "/files clear-all confirm" : "/files clear-meta confirm"
            }
          },
          {
            type: "button" as const,
            style: "secondary" as const,
            action: {
              type: "postback" as const,
              label: "ยกเลิก",
              data: "file-purge|cancel|confirm",
              displayText: "ยกเลิกการล้างไฟล์"
            }
          }
        ]
      }
    }
  } as any;
}

function buildUploadSuccessFlexMessage(input: UploadSuccessCardInput) {
  const footerButtons: any[] = [
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
    footerButtons.push({
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
    altText: `บันทึกไฟล์สำเร็จ: ${input.title}`,
    contents: {
      type: "bubble" as const,
      size: "giga",
      header: {
        type: "box" as const,
        layout: "vertical" as const,
        paddingAll: "16px",
        backgroundColor: input.driveFailed ? "#b45309" : "#15803d",
        contents: [
          {
            type: "text" as const,
            text: input.driveFailed ? "บันทึกไฟล์แล้ว" : "บันทึกไฟล์สำเร็จ",
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
            text: input.title,
            wrap: true,
            weight: "bold",
            size: "md",
            color: "#111827"
          },
          {
            type: "text" as const,
            text: input.isImage
              ? "ไฟล์รูปถูกเก็บในระบบแล้ว"
              : "ไฟล์เอกสารถูกเก็บในระบบแล้ว",
            wrap: true,
            size: "sm",
            color: "#475569"
          },
          {
            type: "text" as const,
            text: input.driveFailed
              ? "Google Drive ยังไม่สำเร็จในรอบนี้ แต่สำเนาในระบบพร้อมใช้งาน"
              : input.driveUrl
                ? "มีทั้งสำเนาในระบบและ Google Drive"
                : "สำเนาในระบบพร้อมใช้งาน",
            wrap: true,
            size: "sm",
            color: input.driveFailed ? "#b45309" : "#475569"
          },
          {
            type: "separator" as const,
            margin: "sm"
          },
          {
            type: "text" as const,
            text: "ใช้คำสั่ง \"ส่งไฟล์นี้ให้ [ชื่อ] [ข้อความ]\" เพื่อส่งต่อได้เลย",
            wrap: true,
            size: "sm",
            color: "#111827"
          }
        ]
      },
      footer: {
        type: "box" as const,
        layout: "vertical" as const,
        spacing: "sm",
        paddingAll: "16px",
        contents: footerButtons
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
}, extras?: {
  botInstruction?: string | null;
  persona?: RolePersonaRow | null;
}) {
  const lines = [
    "You are the ACDC Core assistant for internal staff operations.",
    `Current role: ${user.role}`,
    `Nickname: ${user.nickname ?? "-"}`,
    `LINE display name: ${user.line_display_name ?? "-"}`,
    "Respect role boundaries. Do not claim a calendar action has been completed unless the Koyeb1 backend actually performed it.",
    "If the request is informational, answer directly and clearly in Thai."
  ];

  if (extras?.botInstruction?.trim()) {
    lines.push(`System instruction: ${extras.botInstruction.trim()}`);
  }

  if (extras?.persona) {
    if (extras.persona.greeting?.trim()) {
      lines.push(`Preferred greeting: ${extras.persona.greeting.trim()}`);
    }
    if (extras.persona.tone?.trim()) {
      lines.push(`Tone policy: ${extras.persona.tone.trim()}`);
    }
    if (extras.persona.behavior?.trim()) {
      lines.push(`Behavior policy: ${extras.persona.behavior.trim()}`);
    }
  }

  lines.push(...getRolePolicyHints(user.role));

  return lines.join("\n");
}

async function getAIContextConfig(role: string) {
  const normalizedRole = role.toUpperCase();
  const [{ data: botConfig }, { data: persona }] = await Promise.all([
    supabaseAdmin.from("bot_config").select("system_instruction, is_active").eq("id", "default").maybeSingle(),
    supabaseAdmin
      .from("role_personas")
      .select("role, greeting, tone, behavior")
      .eq("role", normalizedRole)
      .maybeSingle()
  ]);

  return {
    botInstruction: botConfig?.is_active === false ? null : botConfig?.system_instruction ?? null,
    persona: (persona ?? null) as RolePersonaRow | null
  };
}

async function findStaffUser(target: string) {
  const roleKeyword = resolveRoleKeyword(target);
  if (roleKeyword) {
    const byRoleKeyword = await supabaseAdmin
      .from("users")
      .select("id, username, role, line_user_id, line_display_name, nickname")
      .eq("role", roleKeyword)
      .limit(1);

    if (byRoleKeyword.error) {
      throw byRoleKeyword.error;
    }

    if (byRoleKeyword.data?.[0]) {
      return byRoleKeyword.data[0];
    }
  }

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

function shouldRouteAiPromptToQuickAction(prompt: string): boolean {
  const normalized = normalizeTextCommand(prompt);
  const matched = extensionCommandRegistry.match(normalized);
  if (
    matched &&
    matched.command.category !== "ai" &&
    matched.command.category !== "help" &&
    matched.command.category !== "system"
  ) {
    return true;
  }

  return (
    normalized.startsWith("/event ") ||
    normalized.startsWith("/summary ") ||
    normalized.startsWith("/card ") ||
    normalized.startsWith("/staff send ") ||
    normalized.startsWith("/clarify day ") ||
    normalized.startsWith("เรียก ")
  );
}

async function sendStaffMessage(input: {
  senderUserId: string | null;
  senderRole: string;
  senderDisplayName?: string;
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
  const senderDisplayName = input.senderDisplayName ?? input.senderRole;

  if (input.includeCachedFile && attachmentRecordId && requiresSecretaryReview(input.senderRole)) {
    const secretaryUser = await findStaffUser("SECRETARY");
    if (!secretaryUser || !secretaryUser.line_user_id) {
      return "⚠️ ยังไม่พบเลขาในระบบสำหรับรับตรวจไฟล์ก่อนส่งให้ผู้พันครับ";
    }

    const bossUser = await findStaffUser("BOSS");
    await updateUploadedFileReviewState({
      id: attachmentRecordId,
      reviewStatus: "pending_secretary_review",
      reviewRequestedToUserId: secretaryUser.id,
      reviewTargetUserId: bossUser?.id ?? null,
      reviewMessage: input.message,
      reviewReason: null
    });

    if (attachmentName && shortOpenUrl) {
      await getLineClient().pushMessage(
        secretaryUser.line_user_id,
        buildFileReviewFlexMessage({
          fileId: attachmentRecordId,
          fileName: attachmentName,
          senderRole: input.senderRole,
          senderDisplayName,
          instruction: input.message,
          openUrl: shortOpenUrl,
          driveUrl: attachmentDriveUrl || undefined
        })
      );
    } else {
      await pushTextMessage(
        secretaryUser.line_user_id,
        `📨 มีไฟล์จาก ${senderDisplayName} รอตรวจ\n\n${input.message}`
      );
    }

    await supabaseAdmin.from("staff_messages").insert({
      sender_user_id: input.senderUserId,
      target_user_id: secretaryUser.id,
      target_line_user_id: secretaryUser.line_user_id,
      message: `[REVIEW] ${input.message}`,
      file_url: attachmentDriveUrl ?? attachmentLocalUrl ?? null,
      status: "pending_secretary_review",
      sent_at: new Date().toISOString()
    });

    return `✅ ส่งไฟล์เข้าเลขาเพื่อตรวจแล้ว เมื่อเลขาอนุมัติ ระบบจะส่งต่อให้ผู้พันครับ`;
  }

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

function normalizeAcknowledgementTarget(target: string): string {
  return target
    .trim()
    .replace(/\s*(ให้หน่อย|ให้ที|หน่อยครับ|หน่อยค่ะ|หน่อยคะ|หน่อย|ทีนะ|ที)$/i, "")
    .trim();
}

async function sendAcknowledgementRequest(input: {
  senderUserId: string | null;
  senderRole: string;
  senderDisplayName: string;
  target: string;
}) {
  const normalizedTarget = normalizeAcknowledgementTarget(input.target);
  if (!normalizedTarget) {
    return "⚠️ ระบุผู้รับคำสั่งก่อนครับ เช่น เรียก นยก";
  }

  const targetUser = await findStaffUser(normalizedTarget);
  if (!targetUser || !targetUser.line_user_id) {
    return `⚠️ ไม่พบบุคคลที่สามารถรับคำสั่งได้จากคำว่า "${normalizedTarget}"`;
  }

  if (!canReceiveAcknowledgement(targetUser.role)) {
    return `⚠️ คำสั่งเรียกแบบตอบรับด่วนรองรับเฉพาะ นยก / นกบ / นกพ / นกง ตอนนี้ ${resolveUserDisplayName(targetUser)} ยังไม่อยู่ในกลุ่มนี้ครับ`;
  }

  const message = `ผู้พันเรียก ${resolveUserDisplayName(targetUser)}`;
  const insertResult = await supabaseAdmin
    .from("staff_messages")
    .insert({
      sender_user_id: input.senderUserId,
      target_user_id: targetUser.id,
      target_line_user_id: targetUser.line_user_id,
      message,
      status: "awaiting_ack",
      sent_at: new Date().toISOString()
    })
    .select("id")
    .single();

  if (insertResult.error) {
    throw insertResult.error;
  }

  await getLineClient().pushMessage(
    targetUser.line_user_id,
    buildAcknowledgementFlexMessage({
      requestId: insertResult.data.id,
      requesterRole: input.senderRole,
      requesterDisplayName: input.senderDisplayName,
      targetDisplayName: resolveUserDisplayName(targetUser)
    })
  );

  return `✅ ส่งคำสั่งเรียกถึง ${resolveUserDisplayName(targetUser)} แล้ว ระบบจะรอการตอบรับครับ`;
}

async function handleAcknowledgementPostback(
  event: WebhookEvent & { type: "postback"; postback: { data: string }; replyToken: string; source: { userId?: string } }
) {
  const lineUserId = event.source.userId;
  if (!lineUserId) {
    return;
  }

  const match = event.postback.data.match(/^ack\|([^|]+)\|(acknowledged|outside)$/);
  if (!match) {
    await replyText(event.replyToken, "⚠️ รูปแบบการตอบรับไม่ถูกต้องครับ");
    return;
  }

  const [, requestId, action] = match as [string, string, AcknowledgementAction];
  const actingUser = await ensureLineUser(lineUserId);
  const { data: staffMessage, error } = await supabaseAdmin
    .from("staff_messages")
    .select("id, sender_user_id, target_user_id, target_line_user_id, message, status")
    .eq("id", requestId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!staffMessage || staffMessage.target_line_user_id !== lineUserId) {
    await replyText(event.replyToken, "⚠️ ไม่พบคำสั่งที่ต้องตอบรับรายการนี้ครับ");
    return;
  }

  if (staffMessage.status !== "awaiting_ack") {
    await replyText(event.replyToken, "ℹ️ รายการนี้ถูกตอบรับไปแล้วครับ");
    return;
  }

  const nextStatus = action === "acknowledged" ? "acknowledged" : "outside";
  const targetDisplayName = resolveUserDisplayName(actingUser);
  const acknowledgementText =
    action === "acknowledged" ? `${targetDisplayName}: ทราบครับ` : `${targetDisplayName}: ขออภัยครับ ตอนนี้อยู่ด้านนอก`;

  const updateResult = await supabaseAdmin
    .from("staff_messages")
    .update({
      status: nextStatus,
      message: `${staffMessage.message}\n${acknowledgementText}`
    })
    .eq("id", requestId);

  if (updateResult.error) {
    throw updateResult.error;
  }

  if (staffMessage.sender_user_id) {
    const senderLookup = await supabaseAdmin
      .from("users")
      .select("line_user_id")
      .eq("id", staffMessage.sender_user_id)
      .maybeSingle();

    if (!senderLookup.error && senderLookup.data?.line_user_id) {
      const bossNotice =
        action === "acknowledged"
          ? `✅ ${targetDisplayName} ตอบรับแล้ว: ทราบครับ`
          : `⚠️ ${targetDisplayName} แจ้งว่า: ขออภัยครับ ตอนนี้อยู่ด้านนอก`;
      await pushTextMessage(senderLookup.data.line_user_id, bossNotice, {
        title: "ตอบรับคำสั่ง",
        accentColor: action === "acknowledged" ? "#15803d" : "#b45309"
      });
    }
  }

  const replyMessage =
    action === "acknowledged"
      ? "✅ ระบบแจ้งกลับหาผู้พันแล้ว: ทราบครับ"
      : "✅ ระบบแจ้งกลับหาผู้พันแล้ว: ขออภัยครับ ตอนนี้อยู่ด้านนอก";
  await replyText(event.replyToken, replyMessage, {
    title: "ตอบรับคำสั่ง",
    accentColor: action === "acknowledged" ? "#15803d" : "#b45309"
  });
}

async function notifyFileSubmitter(input: {
  fileRecord: Awaited<ReturnType<typeof getUploadedFileById>>;
  message: string;
  title: string;
  accentColor: string;
}) {
  const submitterLineUserId = input.fileRecord?.lineUserId;
  if (!submitterLineUserId) {
    return;
  }

  await pushTextMessage(submitterLineUserId, input.message, {
    title: input.title,
    accentColor: input.accentColor
  });
}

async function forwardReviewedFileToBoss(input: {
  fileRecordId: string;
  secretaryDisplayName: string;
  instruction: string | null;
}) {
  const fileRecord = await getUploadedFileById(input.fileRecordId);
  if (!fileRecord) {
    return "⚠️ ไม่พบไฟล์รายการนี้ในระบบครับ";
  }

  const bossUser = await findStaffUser("BOSS");
  if (!bossUser || !bossUser.line_user_id) {
    return "⚠️ ยังไม่พบบัญชีผู้พันในระบบ จึงส่งไฟล์ต่อให้ไม่ได้ครับ";
  }

  const fileName = fileRecord.originalFileName ?? fileRecord.fileName;
  const openUrl =
    config.PUBLIC_BASE_URL && fileRecord.id
      ? `${config.PUBLIC_BASE_URL}/f/${fileRecord.id}`
      : fileRecord.localDiskUrl || fileRecord.driveUrl;

  if (!openUrl) {
    return "⚠️ ไฟล์นี้ยังไม่มีลิงก์เปิดใช้งานในระบบครับ";
  }

  const instruction = input.instruction?.trim() || "เลขาอนุมัติเอกสารและส่งต่อให้ผู้พันแล้ว";
  await getLineClient().pushMessage(
    bossUser.line_user_id,
    buildFileDeliveryFlexMessage({
      senderRole: "SECRETARY",
      instruction,
      fileRecordId: fileRecord.id,
      fileName,
      openUrl,
      driveUrl: fileRecord.driveUrl || undefined
    })
  );

  await updateUploadedFileReviewState({
    id: fileRecord.id,
    reviewStatus: "approved",
    reviewRequestedToUserId: null,
    reviewTargetUserId: bossUser.id,
    reviewMessage: instruction,
    reviewReason: null
  });

  await notifyFileSubmitter({
    fileRecord,
    message: `✅ เลขาอนุมัติไฟล์ "${fileName}" แล้ว และระบบส่งต่อให้ผู้พันเรียบร้อยครับ`,
    title: "ผลตรวจไฟล์",
    accentColor: "#15803d"
  });

  return `✅ เลขาอนุมัติแล้ว และระบบส่งไฟล์ "${fileName}" ต่อให้ผู้พันเรียบร้อยครับ`;
}

async function rejectReviewedFile(input: {
  fileRecordId: string;
  secretaryDisplayName: string;
  reason: string;
}) {
  const fileRecord = await getUploadedFileById(input.fileRecordId);
  if (!fileRecord) {
    return "⚠️ ไม่พบไฟล์รายการนี้ในระบบครับ";
  }

  const fileName = fileRecord.originalFileName ?? fileRecord.fileName;
  await updateUploadedFileReviewState({
    id: fileRecord.id,
    reviewStatus: "rejected",
    reviewRequestedToUserId: null,
    reviewTargetUserId: fileRecord.reviewTargetUserId ?? null,
    reviewMessage: fileRecord.reviewMessage ?? null,
    reviewReason: input.reason
  });

  await notifyFileSubmitter({
    fileRecord,
    message: `⚠️ เลขาปฏิเสธไฟล์ "${fileName}"\nเหตุผล: ${input.reason}`,
    title: "ผลตรวจไฟล์",
    accentColor: "#b45309"
  });

  return `✅ ปฏิเสธไฟล์ "${fileName}" แล้ว และแจ้งเหตุผลกลับผู้ส่งเรียบร้อยครับ`;
}

async function buildFilePurgeSummary(lineUserId: string): Promise<{
  fileCount: number;
  latestFileName: string | null;
}> {
  const files = await getAllUploadedFilesForLineUser(lineUserId);
  return {
    fileCount: files.length,
    latestFileName: files[0]?.originalFileName ?? files[0]?.fileName ?? null
  };
}

async function purgeUploadedFilesForLineUser(input: {
  lineUserId: string;
  scope: "meta" | "all";
}): Promise<string> {
  const files = await getAllUploadedFilesForLineUser(input.lineUserId);
  if (files.length === 0) {
    return "ℹ️ ตอนนี้ยังไม่มีไฟล์ของบัญชีนี้ให้ลบครับ";
  }

  let deletedDriveCount = 0;
  let deletedLocalCount = 0;
  let deletedMetaCount = 0;
  let driveDeleteFailures = 0;

  for (const file of files) {
    if (input.scope === "all") {
      if (file.localDiskPath) {
        await removeStoredFileArtifacts(file.localDiskPath);
        deletedLocalCount += 1;
      }

      if (file.driveFileId) {
        try {
          await deleteFileFromDrive(file.driveFileId);
          deletedDriveCount += 1;
        } catch {
          driveDeleteFailures += 1;
        }
      }
    } else {
      await removeExtractionSidecar(file.localDiskPath);
    }

    await deleteUploadedFileRecord(file.id);
    deletedMetaCount += 1;
  }

  clearTransientUserState(input.lineUserId);

  const lines = [
    input.scope === "all" ? "🧹 ล้างไฟล์ทั้งหมดเรียบร้อยแล้ว" : "🧹 ล้าง metadata ไฟล์เรียบร้อยแล้ว",
    "",
    `ลบ metadata: ${deletedMetaCount} รายการ`
  ];

  if (input.scope === "all") {
    lines.push(`ลบ local file/sidecar: ${deletedLocalCount} รายการ`);
    lines.push(`ลบ Google Drive: ${deletedDriveCount} รายการ`);
    if (driveDeleteFailures > 0) {
      lines.push(`ลบ Google Drive ไม่สำเร็จ: ${driveDeleteFailures} รายการ`);
    }
  }

  return lines.join("\n");
}

async function handleFilePurgePostback(
  event: WebhookEvent & { type: "postback"; postback: { data: string }; replyToken: string; source: { userId?: string } }
) {
  const lineUserId = event.source.userId;
  if (!lineUserId) {
    return;
  }

  const match = event.postback.data.match(/^file-purge\|(meta|all|cancel)\|(prepare|confirm)$/);
  if (!match) {
    await replyText(event.replyToken, "⚠️ รูปแบบคำสั่งล้างไฟล์ไม่ถูกต้องครับ");
    return;
  }

  const [, scopeToken, stage] = match as [string, "meta" | "all" | "cancel", "prepare" | "confirm"];
  const actingUser = await ensureLineUser(lineUserId);
  if (!canManageFilePurge(actingUser.role)) {
    await replyText(event.replyToken, "⚠️ คำสั่งล้างไฟล์ชุดนี้เปิดให้เฉพาะ DEV ครับ");
    return;
  }

  if (scopeToken === "cancel") {
    pendingFilePurgeState.delete(lineUserId);
    await replyText(event.replyToken, "✅ ยกเลิกการล้างไฟล์แล้วครับ", {
      title: "ล้างไฟล์",
      accentColor: "#2563eb"
    });
    return;
  }

  if (stage === "prepare") {
    const summary = await buildFilePurgeSummary(lineUserId);
    pendingFilePurgeState.set(lineUserId, {
      scope: scopeToken,
      count: summary.fileCount
    });
    await getLineClient().replyMessage(event.replyToken, buildFilePurgeConfirmFlexMessage({
      scope: scopeToken,
      fileCount: summary.fileCount
    }));
    return;
  }

  const pending = pendingFilePurgeState.get(lineUserId);
  if (!pending || pending.scope !== scopeToken) {
    await replyText(event.replyToken, "⚠️ ไม่พบรายการยืนยันล่าสุดแล้วครับ ลองใช้ /files status ใหม่อีกครั้ง", {
      title: "ล้างไฟล์",
      accentColor: "#b45309"
    });
    return;
  }

  pendingFilePurgeState.delete(lineUserId);
  const message = await purgeUploadedFilesForLineUser({
    lineUserId,
    scope: scopeToken
  });
  await replyText(event.replyToken, message, {
    title: "ล้างไฟล์",
    accentColor: scopeToken === "all" ? "#b91c1c" : "#92400e"
  });
}

async function handleFileReviewPostback(
  event: WebhookEvent & { type: "postback"; postback: { data: string }; replyToken: string; source: { userId?: string } }
) {
  const lineUserId = event.source.userId;
  if (!lineUserId) {
    return;
  }

  const match = event.postback.data.match(/^file-review\|([^|]+)\|(approve|reject)$/);
  if (!match) {
    await replyText(event.replyToken, "⚠️ รูปแบบการตรวจไฟล์ไม่ถูกต้องครับ");
    return;
  }

  const [, fileId, action] = match as [string, string, FileReviewAction];
  const actingUser = await ensureLineUser(lineUserId);
  if (!isSecretaryRole(actingUser.role)) {
    await replyText(event.replyToken, "⚠️ การตรวจไฟล์ชุดนี้เปิดให้เฉพาะเลขาครับ");
    return;
  }

  const fileRecord = await getUploadedFileById(fileId);
  if (!fileRecord) {
    await replyText(event.replyToken, "⚠️ ไม่พบไฟล์รายการนี้ในระบบครับ");
    return;
  }

  if (fileRecord.reviewStatus !== "pending_secretary_review") {
    await replyText(event.replyToken, "ℹ️ ไฟล์รายการนี้ถูกดำเนินการไปแล้วครับ");
    return;
  }

  if (action === "approve") {
    const message = await forwardReviewedFileToBoss({
      fileRecordId: fileId,
      secretaryDisplayName: resolveUserDisplayName(actingUser),
      instruction: fileRecord.reviewMessage ?? null
    });
    await replyText(event.replyToken, message, {
      title: "ตรวจไฟล์",
      accentColor: "#15803d"
    });
    return;
  }

  pendingRejectReviewState.set(lineUserId, {
    fileId,
    requesterUserId: fileRecord.userId ?? null
  });
  await replyText(
    event.replyToken,
    "📝 กรุณาพิมพ์เหตุผลที่ปฏิเสธไฟล์นี้ได้เลยครับ ระบบจะส่งกลับไปหาผู้ส่งทันที",
    {
      title: "ปฏิเสธไฟล์",
      accentColor: "#b45309"
    }
  );
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
  ownerUserId?: string | null;
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
    owner_user_id: input.ownerUserId ?? null,
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

function containsAiSummaryKeyword(text: string): boolean {
  return /(สรุปงาน|รายงาน|สรุปตาราง|สรุป.*งาน)/i.test(normalizeCommonThaiTypos(text));
}

function containsAiFileKeyword(text: string): boolean {
  return /(ไฟล์|เอกสาร|pdf|docx|xlsx|รูป|รูปภาพ)/i.test(normalizeCommonThaiTypos(text));
}

function getAiSummaryRangeFromPrompt(prompt: string): DateRangePreset | null {
  const trimmed = normalizeCommonThaiTypos(prompt.trim());

  if (!containsAiSummaryKeyword(trimmed)) {
    return null;
  }

  const summaryRangeMatch = trimmed.match(/^.*สรุปงานช่วง\s+(.+?)\s+ถึง\s+(.+)$/i);
  if (summaryRangeMatch) {
    const start = parseDateInput(summaryRangeMatch[1].trim(), false);
    const end = parseDateInput(summaryRangeMatch[2].trim(), true);
    if (!start || !end) {
      return null;
    }
    return {
      start,
      end,
      label: `${formatThaiDate(start)} - ${formatThaiDate(end)}`,
      title: "สรุปงานตามช่วงเวลา"
    };
  }

  if (matchesSummaryIntent(trimmed, "วันนี้")) {
    return {
      ...getRangeFromPreset("today"),
      title: "สรุปงานวันนี้"
    };
  }

  if (matchesSummaryIntent(trimmed, "เมื่อวาน")) {
    return getRangeForDayExpression("เมื่อวาน", "สรุปงาน");
  }

  if (matchesSummaryIntent(trimmed, "พรุ่งนี้")) {
    return {
      ...getRangeFromPreset("tomorrow"),
      title: "สรุปงานพรุ่งนี้"
    };
  }

  if (matchesSummaryIntent(trimmed, "มะรืน")) {
    return {
      ...getRangeFromPreset("dayaftertomorrow"),
      title: "สรุปงานมะรืน"
    };
  }

  if (matchesSummaryIntent(trimmed, "สัปดาห์นี้")) {
    return {
      ...getRangeFromPreset("week"),
      title: "สรุปงานสัปดาห์นี้"
    };
  }

  if (matchesSummaryIntent(trimmed, "สัปดาห์หน้า")) {
    return {
      ...getRangeFromPreset("nextweek"),
      title: "สรุปงานสัปดาห์หน้า"
    };
  }

  if (matchesSummaryIntent(trimmed, "เดือนนี้")) {
    return {
      ...getRangeFromPreset("month"),
      title: "สรุปงานเดือนนี้"
    };
  }

  if (matchesSummaryIntent(trimmed, "เดือนหน้า")) {
    return {
      ...getRangeFromPreset("nextmonth"),
      title: "สรุปงานเดือนหน้า"
    };
  }

  const dayExpressionMatch = trimmed.match(
    /((?:เมื่อวาน|วันนี้|พรุ่งนี้|มะรืน|(?:วัน)?(?:จันทร์|อังคาร|พุธ|พฤหัส|พฤหัสบดี|ศุกร์|เสาร์|อาทิตย์)(?:นี้|หน้า)?))/i
  );
  if (dayExpressionMatch?.[1]) {
    return getRangeForDayExpression(dayExpressionMatch[1].trim(), "สรุปงาน");
  }

  return null;
}

function buildRetrievedScheduleSummaryContext(input: {
  user: {
    role: string;
    nickname?: string | null;
    line_display_name?: string | null;
  };
  range: DateRangePreset;
  events: CalendarEventRow[];
  aiContextConfig: {
    botInstruction?: string | null;
    persona?: RolePersonaRow | null;
  };
}) {
  const total = input.events.length;
  const internalCount = input.events.filter((event) => event.location_type === "INTERNAL").length;
  const majorCount = input.events.filter((event) => event.location_type === "MAJOR_UNIT").length;
  const outsideCount = input.events.filter((event) => event.location_type === "OUTSIDE").length;

  const verifiedPayload = {
    source: "calendar_events",
    title: input.range.title,
    label: input.range.label,
    total,
    counts: {
      internal: internalCount,
      majorUnit: majorCount,
      outside: outsideCount
    },
    events: input.events.map((event) => ({
      title: event.title,
      startAt: event.start_at,
      endAt: event.end_at,
      locationType: event.location_type ?? "INTERNAL",
      locationDisplayName: event.location_display_name ?? null,
      description: event.description ?? null,
      note: event.note ?? null,
      dressCode: event.dress_code ?? null,
      taskDetails: event.task_details ?? null
    }))
  };

  return [
    buildRoleContext(input.user, input.aiContextConfig),
    "You are in explicit AI mode.",
    "Use only the verified schedule data below.",
    "Do not invent events, times, locations, or totals.",
    "If there are no events, say clearly that no verified schedule items were found for that period.",
    "If the user asks for an executive-style answer, keep it concise and decision-oriented.",
    `Verified schedule data: ${JSON.stringify(verifiedPayload)}`
  ].join("\n");
}

async function tryHandleRetrievedAiPrompt(input: {
  prompt: string;
  user: {
    id: string | null;
    role: string;
    nickname?: string | null;
    line_display_name?: string | null;
  };
  lineUserId: string;
}): Promise<string | null> {
  const summaryRange = getAiSummaryRangeFromPrompt(input.prompt);
  if (!summaryRange) {
    return null;
  }

  if (!canRequestSummary(input.user.role)) {
    return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ดูสรุปงานครับ";
  }

  const [events, aiContextConfig] = await Promise.all([
    getEventsBetween(summaryRange.start, summaryRange.end),
    getAIContextConfig(input.user.role)
  ]);

  const result = await requestGatewayChat({
    prompt: input.prompt,
    policy: config.KOYEB0_DEFAULT_POLICY,
    context: buildRetrievedScheduleSummaryContext({
      user: input.user,
      range: summaryRange,
      events,
      aiContextConfig
    }),
    metadata: {
      source: "line_ai_retrieved_schedule_summary",
      lineUserId: input.lineUserId,
      role: input.user.role,
      rangeLabel: summaryRange.label,
      eventCount: events.length
    }
  });

  return result.text || "ขออภัยครับ ตอนนี้ยังไม่สามารถสรุปข้อมูลได้";
}

function buildRetrievedFileContext(input: {
  user: {
    role: string;
    nickname?: string | null;
    line_display_name?: string | null;
  };
  files: Array<{
    id: string;
    fileName: string;
    originalFileName: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    reviewStatus?: string | null;
    reviewMessage?: string | null;
    reviewReason?: string | null;
    driveSyncStatus?: string | null;
    driveUrl?: string | null;
    localDiskUrl?: string | null;
    createdAt?: string | null;
    previewText?: string | null;
    summaryShort?: string | null;
    pageCount?: number | null;
    extractionStatus?: string | null;
    extractionError?: string | null;
  }>;
  aiContextConfig: {
    botInstruction?: string | null;
    persona?: RolePersonaRow | null;
  };
}) {
  const verifiedPayload = {
    source: "uploaded_files",
    total: input.files.length,
    files: input.files.map((file) => ({
      id: file.id,
      fileName: file.originalFileName ?? file.fileName,
      mimeType: file.mimeType ?? "unknown",
      sizeBytes: file.sizeBytes ?? null,
      reviewStatus: file.reviewStatus ?? "none",
      reviewMessage: file.reviewMessage ?? null,
      reviewReason: file.reviewReason ?? null,
      driveSyncStatus: file.driveSyncStatus ?? "unknown",
      hasDriveUrl: Boolean(file.driveUrl),
      hasLocalCopy: Boolean(file.localDiskUrl),
      createdAt: file.createdAt ?? null,
      extractionStatus: file.extractionStatus ?? "pending",
      extractionError: file.extractionError ?? null,
      pageCount: file.pageCount ?? null,
      summaryShort: file.summaryShort ?? null,
      previewText: file.previewText ? file.previewText.slice(0, 1500) : null
    }))
  };

  return [
    buildRoleContext(input.user, input.aiContextConfig),
    "You are in explicit AI mode.",
    "Use only the verified file registry data below.",
    "Do not invent file contents, page contents, or summaries of the document body beyond the extracted preview.",
    "You may summarize file metadata, status, review flow, likely next step, and extracted preview when it exists.",
    "If extracted preview exists, make it clear that you are summarizing from the extracted preview only, not the full original file.",
    "If the user asks about actual document contents and no extracted preview exists, say clearly that the system only has file metadata right now.",
    `Verified file data: ${JSON.stringify(verifiedPayload)}`
  ].join("\n");
}

function buildDeterministicFileAnswer(input: {
  prompt: string;
  files: Array<{
    fileName: string;
    originalFileName: string | null;
    mimeType: string | null;
    createdAt?: string | null;
    extractionStatus?: string | null;
    extractionError?: string | null;
    summaryShort?: string | null;
    previewText?: string | null;
  }>;
}): string | null {
  const normalizedPrompt = normalizeCommonThaiTypos(input.prompt.trim());
  const primaryFile = input.files[0];
  if (!primaryFile) {
    return "ตอนนี้ยังไม่พบไฟล์ที่ยืนยันได้ในระบบสำหรับบัญชีนี้ครับ";
  }

  const asksForContent = /(เนื้อหา|พูดถึงอะไร|เกี่ยวกับอะไร|สาระ|ใจความ|เบื้องต้นของเอกสาร|สรุปไฟล์ล่าสุด)/i.test(
    normalizedPrompt
  );
  const asksForStatus = /(สถานะไฟล์|อยู่ขั้นตอนไหน|review|อนุมัติ|ปฏิเสธ|drive)/i.test(normalizedPrompt);

  const displayName = primaryFile.originalFileName ?? primaryFile.fileName;
  const createdAt = primaryFile.createdAt ? `\nเวลาอัปโหลด: ${primaryFile.createdAt}` : "";

  if (asksForStatus && !asksForContent) {
    return null;
  }

  if (primaryFile.extractionStatus === "completed" && (primaryFile.summaryShort || primaryFile.previewText)) {
    const summary = primaryFile.summaryShort ?? "มี preview แล้ว แต่ยังสรุปสั้นไม่ได้";
    const previewSnippet = primaryFile.previewText
      ? `\nตัวอย่างข้อความ:\n${primaryFile.previewText.slice(0, 500)}`
      : "";
    return `📄 ไฟล์ล่าสุด: ${displayName}${createdAt}\n\nสรุปเบื้องต้นจาก preview ที่ดึงได้:\n${summary}${previewSnippet}`;
  }

  if (primaryFile.extractionStatus === "unsupported") {
    return `📄 ไฟล์ล่าสุด: ${displayName}${createdAt}\n\nตอนนี้ระบบมี metadata ของไฟล์แล้ว แต่ยังไม่มี extracted preview สำหรับไฟล์ชนิดนี้ครับ`;
  }

  if (primaryFile.extractionStatus === "failed") {
    return `📄 ไฟล์ล่าสุด: ${displayName}${createdAt}\n\nระบบพยายามอ่านเนื้อหาไฟล์แล้ว แต่ยังไม่สำเร็จครับ${primaryFile.extractionError ? `\nสาเหตุ: ${primaryFile.extractionError}` : ""}`;
  }

  if (asksForContent) {
    return `📄 ไฟล์ล่าสุด: ${displayName}${createdAt}\n\nตอนนี้ระบบยังไม่มี extracted preview ที่ยืนยันได้สำหรับไฟล์นี้ครับ`;
  }

  return null;
}

async function tryHandleRetrievedFileAiPrompt(input: {
  prompt: string;
  user: {
    id: string | null;
    role: string;
    nickname?: string | null;
    line_display_name?: string | null;
  };
  lineUserId: string;
}): Promise<string | null> {
  const normalizedPrompt = normalizeCommonThaiTypos(input.prompt.trim());
  if (!containsAiFileKeyword(normalizedPrompt)) {
    return null;
  }

  const asksLatestFile =
    /(ไฟล์ล่าสุด|เอกสารล่าสุด|รูปล่าสุด|ไฟล์นี้|เอกสารนี้)/i.test(normalizedPrompt) ||
    /สรุปไฟล์/i.test(normalizedPrompt) ||
    /สถานะไฟล์/i.test(normalizedPrompt);
  const asksRecentFiles = /(ไฟล์ล่าสุด.*กี่|ไฟล์ช่วงนี้|ไฟล์最近|ไฟล์ไม่กี่รายการล่าสุด|ไฟล์ล่าสุดหลายรายการ)/i.test(
    normalizedPrompt
  );

  if (!asksLatestFile && !asksRecentFiles) {
    return null;
  }

  const [files, aiContextConfig] = await Promise.all([
    asksRecentFiles
      ? getRecentUploadedFilesForLineUser(input.lineUserId, 5)
      : getRecentUploadedFilesForLineUser(input.lineUserId, 3),
    getAIContextConfig(input.user.role)
  ]);

  if (files.length === 0) {
    return "ตอนนี้ยังไม่พบไฟล์ที่ยืนยันได้ในระบบสำหรับบัญชีนี้ครับ";
  }

  const deterministicAnswer = buildDeterministicFileAnswer({
    prompt: input.prompt,
    files
  });
  if (deterministicAnswer) {
    return deterministicAnswer;
  }

  const result = await requestGatewayChat({
    prompt: input.prompt,
    policy: config.KOYEB0_DEFAULT_POLICY,
    context: buildRetrievedFileContext({
      user: input.user,
      files,
      aiContextConfig
    }),
    metadata: {
      source: "line_ai_retrieved_file_summary",
      lineUserId: input.lineUserId,
      role: input.user.role,
      fileCount: files.length
    }
  });

  return result.text || "ขออภัยครับ ตอนนี้ยังไม่สามารถสรุปข้อมูลไฟล์ได้";
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

  const qrUrl = buildCalendarQrUrl(start);
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
    nickname?: string | null;
    line_display_name?: string | null;
    username?: string | null;
  };
  lineUserId: string;
}): Promise<string | null> {
  const trimmed = normalizeTextCommand(input.text);

  if (trimmed === "/help" || trimmed === "/commands" || trimmed === "/menu" || trimmed === "/สิทธิ์") {
    return buildRoleMenuText(input.user.role);
  }

  const helpRoleMatch = trimmed.match(/^\/help role\s+(.+)$/i);
  if (helpRoleMatch) {
    if (!canManageFilePurge(input.user.role)) {
      return "⚠️ คำสั่งดูสิทธิ์ของ role อื่นเปิดให้เฉพาะ DEV ครับ";
    }

    const requestedRole = normalizeHelpRole(helpRoleMatch[1].trim());
    return buildRoleMenuText(requestedRole);
  }

  if (trimmed === "/help ai") {
    return buildAiHelpText(input.user.role);
  }

  if (trimmed === "/help files") {
    return buildFilesHelpText(input.user.role);
  }

  if (trimmed === "/clear") {
    clearTransientUserState(input.lineUserId);
    return [
      "🧹 ล้างสถานะชั่วคราวให้แล้วครับ",
      "",
      "สิ่งที่ถูกล้าง:",
      "- AI Mode",
      "- file context ล่าสุดใน memory",
      "- pending reject/review state",
      "",
      "หมายเหตุ: ไม่ได้ลบข้อมูลจริงในฐานข้อมูล และไม่ได้ลบไฟล์หรือ job ถาวรครับ"
    ].join("\n");
  }

  if (trimmed === "/status") {
    const [latestFile, pendingCardsResponse] = await Promise.all([
      getLatestUploadedFileForLineUser(input.lineUserId),
      supabaseAdmin
        .from("generated_cards")
        .select("id", { count: "exact", head: true })
        .eq("requested_by_user_id", input.user.id ?? "")
        .eq("status", "pending")
    ]);

    const aiModeExpiresAt = getAiModeExpiresAt(input.lineUserId);
    const cachedFile = fileContextCache.get(input.lineUserId);
    const pendingRejectReview = pendingRejectReviewState.get(input.lineUserId);
    const pendingCards = pendingCardsResponse.count ?? 0;

    const statusLines = [
      "📊 สถานะระบบของผู้ใช้",
      "",
      `บทบาท: ${input.user.role}`,
      `AI Mode: ${aiModeExpiresAt ? `เปิดอยู่ (หมดอายุ ${new Date(aiModeExpiresAt).toLocaleTimeString("th-TH", { timeZone: config.APP_TIMEZONE })})` : "ปิดอยู่"}`,
      `file context ใน memory: ${cachedFile ? cachedFile.originalFileName ?? cachedFile.fileName : "ไม่มี"}`,
      `ไฟล์ล่าสุดในระบบ: ${latestFile ? latestFile.originalFileName ?? latestFile.fileName : "ไม่มี"}`,
      `extraction ล่าสุด: ${latestFile?.extractionStatus ?? "ไม่มี"}`,
      `pending reject/review state: ${pendingRejectReview ? "มี" : "ไม่มี"}`,
      `pending generated cards: ${pendingCards}`
    ];

    if (latestFile?.reviewStatus) {
      statusLines.push(`review status ล่าสุด: ${latestFile.reviewStatus}`);
    }
    if (latestFile?.driveSyncStatus) {
      statusLines.push(`Drive sync ล่าสุด: ${latestFile.driveSyncStatus}`);
    }
    if (latestFile?.extractionError) {
      statusLines.push(`extraction note: ${latestFile.extractionError}`);
    }

    statusLines.push("", "ถ้ารู้สึกว่างานเก่าค้าง ลองใช้ /clear เพื่อล้าง state ชั่วคราวได้ครับ");
    return statusLines.join("\n");
  }

  if (trimmed === "/files status") {
    if (!canManageFilePurge(input.user.role)) {
      return "⚠️ ชุดคำสั่งจัดการไฟล์นี้เปิดให้เฉพาะ DEV ครับ";
    }

    const summary = await buildFilePurgeSummary(input.lineUserId);
    if (summary.fileCount === 0) {
      return "ℹ️ ตอนนี้ยังไม่มีไฟล์ของบัญชีนี้ในระบบครับ";
    }

    await getLineClient().pushMessage(input.lineUserId, buildFilePurgeFlexMessage({
      fileCount: summary.fileCount,
      latestFileName: summary.latestFileName
    }));
    return "📁 ส่งแผงจัดการไฟล์ให้แล้วครับ เลือกได้ว่าจะล้าง metadata หรือ ล้างทั้งหมดจริง";
  }

  if (trimmed === "/files clear-meta" || trimmed === "/files clear-all") {
    if (!canManageFilePurge(input.user.role)) {
      return "⚠️ ชุดคำสั่งจัดการไฟล์นี้เปิดให้เฉพาะ DEV ครับ";
    }

    const summary = await buildFilePurgeSummary(input.lineUserId);
    if (summary.fileCount === 0) {
      return "ℹ️ ตอนนี้ยังไม่มีไฟล์ของบัญชีนี้ให้ลบครับ";
    }

    const scope = trimmed.endsWith("clear-all") ? "all" : "meta";
    pendingFilePurgeState.set(input.lineUserId, {
      scope,
      count: summary.fileCount
    });

    await getLineClient().pushMessage(input.lineUserId, buildFilePurgeConfirmFlexMessage({
      scope,
      fileCount: summary.fileCount
    }));
    return scope === "all"
      ? "🧹 ส่งการ์ดยืนยันล้างทั้งหมดให้แล้วครับ"
      : "🧹 ส่งการ์ดยืนยันล้าง metadata ให้แล้วครับ";
  }

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

  const eventDayMatch = trimmed.match(/^\/event day\s*\|\s*(.+)$/i);
  if (eventDayMatch) {
    const range = getRangeForDayExpression(eventDayMatch[1].trim(), "ตารางงาน");
    if (!range) {
      return "⚠️ ระบบยังตีความวันดังกล่าวไม่สำเร็จครับ ลองใช้รูปแบบเช่น อังคารหน้า หรือ 2026-04-14";
    }
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

  const summaryDayMatch = trimmed.match(/^\/summary day\s*\|\s*(.+)$/i);
  if (summaryDayMatch) {
    if (!canRequestSummary(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ดูสรุปงานครับ";
    }
    const range = getRangeForDayExpression(summaryDayMatch[1].trim(), "สรุปงาน");
    if (!range) {
      return "⚠️ ระบบยังตีความวันดังกล่าวไม่สำเร็จครับ ลองใช้รูปแบบเช่น อังคารหน้า หรือ 2026-04-14";
    }
    return getSummaryTextForRange(range.start, range.end, range.title, range.label);
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
    const ownerUserId = await resolveDefaultEventOwnerUserId({
      actorUserId: input.user.id,
      actorRole: input.user.role
    });
    return createCalendarEventFromCommand({
      title: addMatch[1].trim(),
      startAt: addMatch[2].trim(),
      endAt: addMatch[3].trim(),
      locationType: addMatch[4]?.trim() ?? "INTERNAL",
      locationDisplayName: addMatch[5]?.trim() ?? null,
      ownerUserId,
      createdBy: buildEventCreatedByLabel({
        source: "line_command",
        actorRole: input.user.role,
        actorDisplayName:
          input.user.nickname ??
          input.user.line_display_name ??
          input.user.username ??
          null
      })
    });
  }

  const quickEventMatch = trimmed.match(/^\/event quick\s*\|\s*(.+)$/i);
  if (quickEventMatch) {
    if (!canManageCalendar(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์เพิ่มกิจกรรมในปฏิทินกลางครับ";
    }

    try {
      const quickEvent = JSON.parse(quickEventMatch[1]) as QuickEventPayload;
      const ownerUserId = await resolveDefaultEventOwnerUserId({
        actorUserId: input.user.id,
        actorRole: input.user.role
      });

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
        ownerUserId,
        createdBy: buildEventCreatedByLabel({
          source: "line_quick_action",
          actorRole: input.user.role,
          actorDisplayName:
            input.user.nickname ??
            input.user.line_display_name ??
            input.user.username ??
            null
        })
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
      senderDisplayName: resolveUserDisplayName(input.user),
      target: staffMatch[1].trim(),
      message: staffMatch[2].trim(),
      lineUserId: input.lineUserId
    });
  }

  const acknowledgementMatch = trimmed.match(/^เรียก\s*(.+)$/i);
  if (acknowledgementMatch) {
    if (!canRequestAcknowledgement(input.user.role)) {
      return "⚠️ ตอนนี้คำสั่งเรียกพร้อมปุ่มตอบรับเปิดให้เฉพาะผู้พันครับ";
    }

    const senderLookup = input.user.id
      ? await supabaseAdmin
          .from("users")
          .select("nickname, line_display_name, username")
          .eq("id", input.user.id)
          .maybeSingle()
      : null;

    if (senderLookup?.error) {
      throw senderLookup.error;
    }

    return sendAcknowledgementRequest({
      senderUserId: input.user.id,
      senderRole: input.user.role,
      senderDisplayName: resolveUserDisplayName(senderLookup?.data ?? { role: input.user.role }),
      target: acknowledgementMatch[1].trim()
    });
  }

  const staffFileMatch =
    trimmed.match(/^ส่งไฟล์(?:นี้)?ให้\s*(.+?)\s+(.+)$/i) ??
    trimmed.match(/^(.+?\.[a-z0-9]{2,6})\s+ส่งไฟล์(?:นี้)?ให้\s*(.+?)\s+(.+)$/i);
  if (staffFileMatch && (fileContextCache.has(input.lineUserId) || (await getLatestUploadedFileForLineUser(input.lineUserId)))) {
    if (!canSendFileForReview(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ส่งไฟล์พร้อมสั่งงานให้ทีมครับ";
    }

    const requestedFileName = staffFileMatch.length === 4 ? staffFileMatch[1].trim() : null;
    const target = staffFileMatch.length === 4 ? staffFileMatch[2].trim() : staffFileMatch[1].trim();
    const message = staffFileMatch.length === 4 ? staffFileMatch[3].trim() : staffFileMatch[2].trim();

    return sendStaffMessage({
      senderUserId: input.user.id,
      senderRole: input.user.role,
      senderDisplayName: resolveUserDisplayName(input.user),
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
  const mimeType = isImage ? "image/jpeg" : inferMimeTypeFromFileName(originalFileName);

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

  await extractUploadedFilePreview({
    id: fileRecord.id,
    fileName: originalFileName,
    mimeType,
    buffer: fileBuffer,
    localDiskPath: storedLocalFile.absolutePath
  });

  let driveResult: { id: string; webViewLink: string | null } | null = null;
  let driveFailed = false;

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
    driveFailed = true;
    const message = error instanceof Error ? error.message : "Unknown Google Drive sync failure";
    await markUploadedFileDriveFailed({
      id: fileRecord.id,
      errorMessage: message
    });
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

  const openUrl =
    config.PUBLIC_BASE_URL && fileRecord.id
      ? `${config.PUBLIC_BASE_URL}/f/${fileRecord.id}`
      : storedLocalFile.publicUrl ?? `${config.PUBLIC_BASE_URL ?? ""}${storedLocalFile.publicPath}`;

  await getLineClient().replyMessage(
    event.replyToken,
    buildUploadSuccessFlexMessage({
      title: originalFileName,
      isImage,
      openUrl,
      driveUrl: driveResult?.webViewLink ?? null,
      driveFailed
    })
  );
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

  const pendingRejectReview = pendingRejectReviewState.get(lineUserId);
  if (pendingRejectReview) {
    if (!trimmed) {
      await replyText(event.replyToken, "⚠️ กรุณาระบุเหตุผลที่ปฏิเสธไฟล์ด้วยครับ");
      return;
    }

    pendingRejectReviewState.delete(lineUserId);
    const rejectResult = await rejectReviewedFile({
      fileRecordId: pendingRejectReview.fileId,
      secretaryDisplayName: resolveUserDisplayName(user),
      reason: trimmed
    });
    await logConversation(lineUserId, user.id, text, rejectResult);
    await replyText(event.replyToken, rejectResult, {
      title: "ปฏิเสธไฟล์",
      accentColor: "#b45309"
    });
    return;
  }

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
    if (!canUseAIMode(user.role)) {
      const message = getAIDisabledMessage(user.role);
      await logConversation(lineUserId, user.id, text, message);
      await replyText(event.replyToken, message, {
        title: "AI Mode",
        accentColor: "#b45309"
      });
      return;
    }

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

    const retrievedAiResult = await tryHandleRetrievedAiPrompt({
      prompt,
      user: {
        id: user.id,
        role: user.role,
        nickname: user.nickname ?? null,
        line_display_name: user.line_display_name ?? null
      },
      lineUserId
    });

    if (retrievedAiResult) {
      await logConversation(lineUserId, user.id, text, retrievedAiResult);
      await replyText(event.replyToken, retrievedAiResult, {
        title: "AI Mode",
        accentColor: "#7c3aed",
        quickReplyExit: true
      });
      return;
    }

    const retrievedFileAiResult = await tryHandleRetrievedFileAiPrompt({
      prompt,
      user: {
        id: user.id,
        role: user.role,
        nickname: user.nickname ?? null,
        line_display_name: user.line_display_name ?? null
      },
      lineUserId
    });

    if (retrievedFileAiResult) {
      await logConversation(lineUserId, user.id, text, retrievedFileAiResult);
      await replyText(event.replyToken, retrievedFileAiResult, {
        title: "AI Mode",
        accentColor: "#7c3aed",
        quickReplyExit: true
      });
      return;
    }

    if (shouldRouteAiPromptToQuickAction(prompt)) {
      const quickActionResult = await tryHandleCommand({
        text: prompt,
        user: {
          id: user.id,
          role: user.role,
          nickname: user.nickname ?? null,
          line_display_name: user.line_display_name ?? null,
          username: user.username ?? null
        },
        lineUserId
      });

      if (quickActionResult) {
        clearAIMode(lineUserId);
        await logConversation(lineUserId, user.id, text, quickActionResult);
        await replyText(event.replyToken, quickActionResult, {
          title: "Quick Action",
          accentColor: "#2563eb"
        });
        return;
      }
    }

    const aiContextConfig = await getAIContextConfig(user.role);
    const result = await requestGatewayChat({
      prompt,
      policy: config.KOYEB0_DEFAULT_POLICY,
      context: `${buildRoleContext(user, aiContextConfig)}\nYou are in explicit AI mode. Answer helpfully in Thai and keep the response aligned with the caller's role policy.`,
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
    if (!canUseAIMode(user.role)) {
      clearAIMode(lineUserId);
      const message = getAIDisabledMessage(user.role);
      await logConversation(lineUserId, user.id, text, message);
      await replyText(event.replyToken, message, {
        title: "AI Mode",
        accentColor: "#b45309"
      });
      return;
    }

    const retrievedAiResult = await tryHandleRetrievedAiPrompt({
      prompt: trimmed,
      user: {
        id: user.id,
        role: user.role,
        nickname: user.nickname ?? null,
        line_display_name: user.line_display_name ?? null
      },
      lineUserId
    });

    if (retrievedAiResult) {
      await logConversation(lineUserId, user.id, text, retrievedAiResult);
      await replyText(event.replyToken, retrievedAiResult, {
        title: "AI Mode",
        accentColor: "#7c3aed",
        quickReplyExit: true
      });
      return;
    }

    const retrievedFileAiResult = await tryHandleRetrievedFileAiPrompt({
      prompt: trimmed,
      user: {
        id: user.id,
        role: user.role,
        nickname: user.nickname ?? null,
        line_display_name: user.line_display_name ?? null
      },
      lineUserId
    });

    if (retrievedFileAiResult) {
      await logConversation(lineUserId, user.id, text, retrievedFileAiResult);
      await replyText(event.replyToken, retrievedFileAiResult, {
        title: "AI Mode",
        accentColor: "#7c3aed",
        quickReplyExit: true
      });
      return;
    }

    if (shouldRouteAiPromptToQuickAction(trimmed)) {
      clearAIMode(lineUserId);
      const quickActionResult = await tryHandleCommand({
        text: trimmed,
        user: {
          id: user.id,
          role: user.role,
          nickname: user.nickname ?? null,
          line_display_name: user.line_display_name ?? null,
          username: user.username ?? null
        },
        lineUserId
      });

      if (quickActionResult) {
        await logConversation(lineUserId, user.id, text, quickActionResult);
        await replyText(event.replyToken, quickActionResult, {
          title: "Quick Action",
          accentColor: "#2563eb"
        });
        return;
      }
    }

    refreshAIMode(lineUserId);
    const aiContextConfig = await getAIContextConfig(user.role);
    const result = await requestGatewayChat({
      prompt: trimmed,
      policy: config.KOYEB0_DEFAULT_POLICY,
      context: `${buildRoleContext(user, aiContextConfig)}\nYou are in explicit AI mode. Answer helpfully in Thai and keep the response aligned with the caller's role policy.`,
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
      role: user.role,
      nickname: user.nickname ?? null,
      line_display_name: user.line_display_name ?? null,
      username: user.username ?? null
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

  if (event.type === "postback") {
    if ((event as WebhookEvent & { postback?: { data?: string } }).postback?.data?.startsWith("file-purge|")) {
      await handleFilePurgePostback(
        event as WebhookEvent & { type: "postback"; postback: { data: string }; replyToken: string; source: { userId?: string } }
      );
      await logWebhookEvent(event, "processed");
      return;
    }

    if ((event as WebhookEvent & { postback?: { data?: string } }).postback?.data?.startsWith("file-review|")) {
      await handleFileReviewPostback(
        event as WebhookEvent & { type: "postback"; postback: { data: string }; replyToken: string; source: { userId?: string } }
      );
      await logWebhookEvent(event, "processed");
      return;
    }

    await handleAcknowledgementPostback(
      event as WebhookEvent & { type: "postback"; postback: { data: string }; replyToken: string; source: { userId?: string } }
    );
    await logWebhookEvent(event, "processed");
    return;
  }

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
