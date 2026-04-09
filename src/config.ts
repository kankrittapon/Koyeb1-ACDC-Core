import * as dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const optionalUrl = z.preprocess(
  (value) => {
    if (typeof value === "string" && value.trim() === "") {
      return undefined;
    }
    return value;
  },
  z.string().url().optional()
);

const configSchema = z.object({
  PORT: z.coerce.number().default(8001),
  NODE_ENV: z.string().default("development"),
  APP_TIMEZONE: z.string().default("Asia/Bangkok"),
  INTERNAL_API_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  DATABASE_URL: z.string().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().optional(),
  LINE_CHANNEL_SECRET: z.string().optional(),
  ENABLE_LINE_WEBHOOK: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  ENABLE_SCHEDULER: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  KOYEB0_BASE_URL: z.string().url(),
  KOYEB0_INTERNAL_API_KEY: z.string().min(1),
  KOYEB0_DEFAULT_POLICY: z.string().default("private_first"),
  CORS_ALLOW_ORIGINS: z.string().optional().default("*"),
  PUBLIC_BASE_URL: optionalUrl,
  NEXTJS_FRONTEND_URL: optionalUrl,
  GOOGLE_DRIVE_CLIENT_ID: z.string().optional(),
  GOOGLE_DRIVE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_DRIVE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_DRIVE_ROOT_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_IMAGE_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_FILE_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_BOSS_ROOT_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_SECRETARY_ROOT_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_ADMIN_ROOT_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_USER_ROOT_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_GUEST_ROOT_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_BOSS_IMAGE_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_SECRETARY_IMAGE_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_ADMIN_IMAGE_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_USER_IMAGE_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_GUEST_IMAGE_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_BOSS_FILE_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_SECRETARY_FILE_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_ADMIN_FILE_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_USER_FILE_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_GUEST_FILE_FOLDER: z.string().optional(),
  DASHBOARD_CARD_URL: optionalUrl,
  MORNING_SUMMARY_CRON: z.string().default("0 7 * * *"),
  EVENING_SUMMARY_CRON: z.string().default("0 18 * * *"),
  EVENT_ALERT_CRON: z.string().default("*/5 * * * *")
});

export const config = configSchema.parse(process.env);
