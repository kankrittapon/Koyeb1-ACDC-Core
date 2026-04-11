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
  OPENCLAW_GATEWAY_URL: z.string().optional(),
  OPENCLAW_GATEWAY_TOKEN: z.string().optional(),
  CORS_ALLOW_ORIGINS: z.string().optional().default("*"),
  PUBLIC_BASE_URL: optionalUrl,
  NEXTJS_FRONTEND_URL: optionalUrl,
  GOOGLE_DRIVE_CLIENT_ID: z.string().optional(),
  GOOGLE_DRIVE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_DRIVE_REFRESH_TOKEN: z.string().optional(),
  GDRIVE_CLIENT_ID: z.string().optional(),
  GDRIVE_CLIENT_SECRET: z.string().optional(),
  GDRIVE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_DRIVE_ROOT_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_IMAGE_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_FILE_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_DOC_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_PDF_FOLDER: z.string().optional(),
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
  GOOGLE_DRIVE_BOSS_DOC_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_SECRETARY_DOC_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_ADMIN_DOC_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_USER_DOC_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_GUEST_DOC_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_BOSS_PDF_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_SECRETARY_PDF_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_ADMIN_PDF_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_USER_PDF_FOLDER: z.string().optional(),
  GOOGLE_DRIVE_GUEST_PDF_FOLDER: z.string().optional(),
  GDRIVE_ROOT: z.string().optional(),
  GDRIVE_DOC: z.string().optional(),
  GDRIVE_PDF: z.string().optional(),
  GDRIVE_PICTURE: z.string().optional(),
  GDRIVE_BOSS_ROOT: z.string().optional(),
  GDRIVE_BOSS_DOC: z.string().optional(),
  GDRIVE_BOSS_PDF: z.string().optional(),
  GDRIVE_BOSS_PICTURE: z.string().optional(),
  GDRIVE_SECRETARY_ROOT: z.string().optional(),
  GDRIVE_SECRETARY_DOC: z.string().optional(),
  GDRIVE_SECRETARY_PDF: z.string().optional(),
  GDRIVE_SECRETARY_PICTURE: z.string().optional(),
  GDRIVE_ADMIN_ROOT: z.string().optional(),
  GDRIVE_ADMIN_DOC: z.string().optional(),
  GDRIVE_ADMIN_PDF: z.string().optional(),
  GDRIVE_ADMIN_PICTURE: z.string().optional(),
  GDRIVE_USER_ROOT: z.string().optional(),
  GDRIVE_USER_DOC: z.string().optional(),
  GDRIVE_USER_PDF: z.string().optional(),
  GDRIVE_USER_PICTURE: z.string().optional(),
  GDRIVE_GUEST_ROOT: z.string().optional(),
  GDRIVE_GUEST_DOC: z.string().optional(),
  GDRIVE_GUEST_PDF: z.string().optional(),
  GDRIVE_GUEST_PICTURE: z.string().optional(),
  DASHBOARD_CARD_URL: optionalUrl,
  FILE_STORAGE_ROOT: z.string().default("storage/uploads"),
  MORNING_SUMMARY_CRON: z.string().default("0 7 * * *"),
  EVENING_SUMMARY_CRON: z.string().default("0 18 * * *"),
  EVENT_ALERT_CRON: z.string().default("*/5 * * * *")
});

export const config = configSchema.parse(process.env);
