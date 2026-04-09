import { Client, middleware, MiddlewareConfig, WebhookEvent } from "@line/bot-sdk";
import { NextFunction, Request, Response } from "express";
import { config } from "../../config";
import { supabaseAdmin } from "../../lib/supabase";
import { requestGatewayChat } from "../ai-gateway/client";
import { uploadFileToDrive } from "../drive/service";
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
  { fileName: string; fileUrl: string; mimeType: string; timestamp: number }
>();

function getLineClient(): Client {
  if (!lineClient) {
    throw new Error("LINE client is not configured");
  }

  return lineClient;
}

function isResearchRequest(text: string): boolean {
  return researchKeywords.some((keyword) => text.includes(keyword));
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

function resolveDayExpression(dayInput: string, now = new Date()): Date | null {
  const trimmed = dayInput.trim().toLowerCase();
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);

  if (trimmed === "วันนี้") {
    return base;
  }

  if (trimmed === "พรุ่งนี้") {
    const date = new Date(base);
    date.setDate(date.getDate() + 1);
    return date;
  }

  if (trimmed === "มะรืน") {
    const date = new Date(base);
    date.setDate(date.getDate() + 2);
    return date;
  }

  const explicit = parseDateInput(dayInput, false);
  if (explicit) {
    return explicit;
  }

  for (const [label, weekday] of weekdayMap.entries()) {
    if (trimmed === label.toLowerCase() || trimmed === `${label.toLowerCase()}นี้`) {
      const date = new Date(base);
      let diff = (weekday - date.getDay() + 7) % 7;
      if (diff === 0) {
        diff = 7;
      }
      date.setDate(date.getDate() + diff);
      return date;
    }

    if (trimmed === `${label.toLowerCase()}หน้า`) {
      const date = new Date(base);
      let diff = (weekday - date.getDay() + 7) % 7;
      if (diff === 0) {
        diff = 7;
      }
      date.setDate(date.getDate() + diff);
      return date;
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

  const start = new Date(date);
  start.setHours(timeRange.startHour, timeRange.startMinute, 0, 0);
  const end = new Date(date);
  end.setHours(timeRange.endHour, timeRange.endMinute, 0, 0);

  if (end.getTime() <= start.getTime()) {
    end.setDate(end.getDate() + 1);
  }

  return { start, end };
}

function formatStructuredDescription(parts: {
  outfit?: string;
  note?: string;
  details?: string;
}): string | null {
  const lines: string[] = [];

  if (parts.outfit) {
    lines.push(`ชุด: ${parts.outfit}`);
  }

  if (parts.note) {
    lines.push(`หมายเหตุ: ${parts.note}`);
  }

  if (parts.details) {
    const detailLines = parts.details
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

  const details = [...extraFields, ...restLines].filter(Boolean).join("\n");
  const description = formatStructuredDescription({
    outfit: outfitField || undefined,
    note: noteField || undefined,
    details: details || undefined
  });

  return {
    title: activityField,
    startAt: dateTimes.start.toISOString(),
    endAt: dateTimes.end.toISOString(),
    locationDisplayName: locationField || null,
    description
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
    startAt: dateTimes.start.toISOString(),
    endAt: dateTimes.end.toISOString(),
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

function getRangeFromPreset(preset: "today" | "week" | "month") {
  const now = new Date();

  if (preset === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return {
      start,
      end,
      label: `ประจำวัน ${formatThaiDate(start)}`,
      title: "ตารางงานวันนี้"
    };
  }

  if (preset === "week") {
    const start = new Date(now);
    const day = start.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + diff);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return {
      start,
      end,
      label: `${formatThaiDate(start)} - ${formatThaiDate(end)}`,
      title: "ตารางงานสัปดาห์นี้"
    };
  }

  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return {
    start,
    end,
    label: `${formatThaiDate(start)} - ${formatThaiDate(end)}`,
    title: "ตารางงานเดือนนี้"
  };
}

type CalendarEventRow = {
  id: string;
  title: string;
  description?: string | null;
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

function normalizeTextCommand(text: string): string {
  const trimmed = text.trim();

  if (
    trimmed === "ตารางวันนี้" ||
    trimmed === "ดูตารางวันนี้" ||
    trimmed === "งานวันนี้"
  ) {
    return "/event today";
  }

  if (
    trimmed === "ตารางสัปดาห์นี้" ||
    trimmed === "ดูตารางสัปดาห์นี้" ||
    trimmed === "งานสัปดาห์นี้"
  ) {
    return "/event week";
  }

  if (
    trimmed === "ตารางเดือนนี้" ||
    trimmed === "ดูตารางเดือนนี้" ||
    trimmed === "งานเดือนนี้"
  ) {
    return "/event month";
  }

  if (trimmed === "สรุปงานวันนี้" || trimmed === "รายงานวันนี้") {
    return "/summary today";
  }

  if (trimmed === "สรุปงานสัปดาห์นี้" || trimmed === "รายงานสัปดาห์นี้") {
    return "/summary week";
  }

  if (trimmed === "สรุปงานเดือนนี้" || trimmed === "รายงานเดือนนี้") {
    return "/summary month";
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

export async function pushTextMessage(lineUserId: string, text: string): Promise<void> {
  await getLineClient().pushMessage(lineUserId, {
    type: "text",
    text
  });
}

export async function pushImageMessage(lineUserId: string, imageUrl: string): Promise<void> {
  await getLineClient().pushMessage(lineUserId, {
    type: "image",
    originalContentUrl: imageUrl,
    previewImageUrl: imageUrl
  });
}

async function replyText(replyToken: string, text: string): Promise<void> {
  await getLineClient().replyMessage(replyToken, {
    type: "text",
    text
  });
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
}) {
  const targetUser = await findStaffUser(input.target);
  if (!targetUser || !targetUser.line_user_id) {
    return `⚠️ ไม่พบบุคคลที่สามารถรับข้อความได้จากคำว่า "${input.target}"`;
  }

  const cachedFile = input.includeCachedFile ? fileContextCache.get(input.lineUserId) : null;
  let fullMessage = `📨 ข้อความจาก ${input.senderRole}\n\n${input.message}`;

  if (cachedFile) {
    fullMessage += `\n\n📎 ไฟล์แนบ: ${cachedFile.fileUrl}`;
  }

  await pushTextMessage(targetUser.line_user_id, fullMessage);

  await supabaseAdmin.from("staff_messages").insert({
    sender_user_id: input.senderUserId,
    target_user_id: targetUser.id,
    target_line_user_id: targetUser.line_user_id,
    message: input.message,
    file_url: cachedFile?.fileUrl ?? null,
    status: "sent",
    sent_at: new Date().toISOString()
  });

  return `✅ ส่งข้อความถึง ${targetUser.nickname ?? targetUser.line_display_name ?? targetUser.username ?? input.target} เรียบร้อยแล้ว`;
}

async function createCalendarEventFromCommand(input: {
  title: string;
  startAt: string;
  endAt: string;
  locationType?: string;
  locationDisplayName?: string;
  description?: string | null;
  createdBy: string;
}) {
  const startDate = parseDateTimeInput(input.startAt);
  const endDate = parseDateTimeInput(input.endAt);

  if (!startDate || !endDate) {
    return "⚠️ รูปแบบวันเวลายังไม่ถูกต้องครับ ใช้รูปแบบเช่น 2026-04-10 09:00";
  }

  const { data, error } = await supabaseAdmin
    .from("calendar_events")
    .insert({
      title: input.title,
      description: input.description ?? null,
      start_at: startDate.toISOString(),
      end_at: endDate.toISOString(),
      location_type: input.locationType ?? "INTERNAL",
      location_display_name: input.locationDisplayName ?? null,
      created_by: input.createdBy
    })
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
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: config.APP_TIMEZONE
  }).format(start);

  const qrUrl = config.DASHBOARD_CARD_URL ?? config.NEXTJS_FRONTEND_URL ?? "https://example.com";
  const card = await generateScheduleCard({
    dateLabel,
    qrUrl,
    events:
      data?.map((event) => ({
        start: new Date(event.start_at).toLocaleTimeString("th-TH", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: config.APP_TIMEZONE
        }),
        end: new Date(event.end_at).toLocaleTimeString("th-TH", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: config.APP_TIMEZONE
        }),
        title: event.title,
        location: event.location_display_name ?? "",
        description: event.description ?? ""
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

  if (trimmed === "/event week") {
    const range = getRangeFromPreset("week");
    return getScheduleTextForRange(range.start, range.end, range.title, range.label);
  }

  if (trimmed === "/event month") {
    const range = getRangeFromPreset("month");
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

  if (trimmed === "/summary week") {
    if (!canRequestSummary(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ดูสรุปงานครับ";
    }
    const range = getRangeFromPreset("week");
    return getSummaryTextForRange(range.start, range.end, "สรุปงานสัปดาห์นี้", range.label);
  }

  if (trimmed === "/summary month") {
    if (!canRequestSummary(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ดูสรุปงานครับ";
    }
    const range = getRangeFromPreset("month");
    return getSummaryTextForRange(range.start, range.end, "สรุปงานเดือนนี้", range.label);
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
      const quickEvent = JSON.parse(quickEventMatch[1]) as {
        title: string;
        startAt: string;
        endAt: string;
        locationDisplayName?: string | null;
        description?: string | null;
      };

      return createCalendarEventFromCommand({
        title: quickEvent.title,
        startAt: quickEvent.startAt,
        endAt: quickEvent.endAt,
        locationType: "OUTSIDE",
        locationDisplayName: quickEvent.locationDisplayName ?? undefined,
        description: quickEvent.description ?? null,
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

  const staffFileMatch = trimmed.match(/^ส่งไฟล์นี้ให้\s+(.+?)\s+(.+)$/i);
  if (staffFileMatch && fileContextCache.has(input.lineUserId)) {
    if (!canMessageStaff(input.user.role)) {
      return "⚠️ บทบาทของคุณยังไม่มีสิทธิ์ส่งไฟล์พร้อมสั่งงานให้ทีมครับ";
    }
    return sendStaffMessage({
      senderUserId: input.user.id,
      senderRole: input.user.role,
      target: staffFileMatch[1].trim(),
      message: staffFileMatch[2].trim(),
      includeCachedFile: true,
      lineUserId: input.lineUserId
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
  const isImage = event.message.type === "image";
  const fileName = isImage
    ? `upload_${Date.now()}.jpg`
    : event.message.fileName ?? `file_${Date.now()}`;
  const mimeType = isImage ? "image/jpeg" : "application/octet-stream";

  const driveResult = await uploadFileToDrive({
    fileName,
    mimeType,
    fileStream,
    folderId: getDriveFolderId(user.role, mimeType)
  });

  fileContextCache.set(lineUserId, {
    fileName,
    fileUrl: driveResult.webViewLink ?? "",
    mimeType,
    timestamp: Date.now()
  });

  await supabaseAdmin.from("uploaded_files").insert({
    user_id: user.id,
    line_user_id: lineUserId,
    file_name: fileName,
    mime_type: mimeType,
    drive_file_id: driveResult.id,
    drive_url: driveResult.webViewLink
  });

  const response = isImage
    ? `✅ บันทึกรูปภาพลง Google Drive เรียบร้อยครับ\n\n📎 Link: ${driveResult.webViewLink}\n\n💡 ใช้คำสั่ง "ส่งไฟล์นี้ให้ [ชื่อ] [ข้อความ]" เพื่อส่งต่อได้เลย`
    : `✅ บันทึกไฟล์ "${fileName}" ลง Google Drive เรียบร้อยครับ\n\n📎 Link: ${driveResult.webViewLink}\n\n💡 ใช้คำสั่ง "ส่งไฟล์นี้ให้ [ชื่อ] [ข้อความ]" เพื่อส่งต่อได้เลย`;

  await replyText(event.replyToken, response);
}

async function handleTextMessage(event: WebhookEvent & { type: "message"; message: { type: "text"; text: string } }) {
  const lineUserId = event.source.userId;
  if (!lineUserId) {
    return;
  }

  const user = await ensureLineUser(lineUserId);
  const text = event.message.text;

  if (user.role === "GUEST") {
    const guestMessage =
      "⚠️ ขออภัยครับ ระบบยังไม่รู้จักคุณในฐานะพนักงาน กรุณาให้ Admin กำหนดสิทธิ์ให้ในระบบก่อนครับ";
    await logConversation(lineUserId, user.id, text, guestMessage);
    await replyText(event.replyToken, guestMessage);
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

  if ((user.role === "BOSS" || user.role === "ADMIN") && isResearchRequest(text)) {
    await replyText(
      event.replyToken,
      "🔎 รับทราบครับ กำลังค้นข้อมูลและสรุปผลให้ โปรดรอสักครู่ครับ"
    );

    setImmediate(async () => {
      try {
        const result = await requestGatewayChat({
          prompt: text,
          policy: "private_first",
          context: `${buildRoleContext(user)}\nResearch mode is active.`,
          metadata: {
            source: "line_async_research",
            lineUserId,
            role: user.role
          }
        });

        const answer = result.text || "ไม่พบคำตอบที่เหมาะสมในขณะนี้ครับ";
        await pushTextMessage(lineUserId, answer);
        await logConversation(lineUserId, user.id, text, answer);
      } catch (error) {
        console.error("[Koyeb1] async LINE research failed:", error);
        await pushTextMessage(
          lineUserId,
          "❌ เกิดข้อผิดพลาดระหว่างการค้นข้อมูลครับ ลองใหม่อีกครั้งได้เลย"
        );
      }
    });

    return;
  }

  const result = await requestGatewayChat({
    prompt: text,
    policy: config.KOYEB0_DEFAULT_POLICY,
    context: buildRoleContext(user),
    metadata: {
      source: "line_chat",
      lineUserId,
      role: user.role
    }
  });

  const answer = result.text || "ขออภัยครับ ตอนนี้ยังไม่สามารถตอบได้";
  await logConversation(lineUserId, user.id, text, answer);
  await replyText(event.replyToken, answer);
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
