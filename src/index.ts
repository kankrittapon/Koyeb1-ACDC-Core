import express, { NextFunction, Request, Response } from "express";
import * as fs from "fs";
import { config } from "./config";
import { supabaseAdmin } from "./lib/supabase";
import { requireAccess, requireRole } from "./middleware/auth";
import { authRouter } from "./modules/auth/routes";
import { usersRouter } from "./modules/users/routes";
import { calendarRouter } from "./modules/calendar/routes";
import { promptsRouter } from "./modules/prompts/routes";
import { logsRouter } from "./modules/logs/routes";
import { lineRouter } from "./modules/line/routes";
import { initScheduler } from "./modules/scheduler/service";
import { schedulerRouter } from "./modules/scheduler/routes";
import { getRequestId } from "./lib/http";

const app = express();

fs.mkdirSync(config.FILE_STORAGE_ROOT, { recursive: true });

const corsAllowedOrigins = config.CORS_ALLOW_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isOriginAllowed(origin: string): boolean {
  return corsAllowedOrigins.some((allowedOrigin) => {
    if (allowedOrigin === "*") {
      return true;
    }

    if (allowedOrigin === origin) {
      return true;
    }

    if (!allowedOrigin.includes("*")) {
      return false;
    }

    const [prefix, ...suffixParts] = allowedOrigin.split("*");
    const suffix = suffixParts.join("*");
    return origin.startsWith(prefix) && origin.endsWith(suffix);
  });
}

app.use((req, res, next) => {
  const origin = req.header("origin");
  const allowAnyOrigin = corsAllowedOrigins.includes("*");

  if (allowAnyOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
    res.setHeader("Vary", "Origin");
  } else if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-internal-api-key, x-line-signature"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

app.use((req, res, next) => {
  res.setHeader("x-request-id", getRequestId(req));
  next();
});
app.use("/images", express.static("public/images"));
app.use("/uploads", express.static(config.FILE_STORAGE_ROOT));

app.get("/", (_req, res) => {
  res.json({
    service: "Koyeb1-ACDC-Core",
    status: "ok",
    role: "acdc-core"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "koyeb1-acdc-core",
    timezone: config.APP_TIMEZONE
  });
});

app.get("/f/:id", async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("uploaded_files")
      .select("id, drive_url, local_disk_url")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return res.status(404).json({ error: "File not found" });
    }

    const target = data.local_disk_url || data.drive_url;
    if (!target) {
      return res.status(404).json({ error: "File URL not available" });
    }

    return res.redirect(302, encodeURI(target));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/modules", (_req, res) => {
  res.json({
    modules: [
      "auth",
      "users",
      "line",
      "calendar",
      "staff",
      "prompts",
      "logs",
      "scheduler",
      "ai-gateway"
    ],
    note: "Scaffold created. Implementation wiring is the next phase."
  });
});

if (config.ENABLE_LINE_WEBHOOK) {
  app.use(lineRouter);
}
app.use(express.json({ limit: "2mb" }));
app.use("/api/auth", authRouter);
app.use("/api/users", requireAccess, requireRole(["DEV", "ADMIN", "SECRETARY", "BOSS"]), usersRouter);
app.use(
  "/api/events",
  requireAccess,
  requireRole(["DEV", "ADMIN", "SECRETARY", "BOSS"]),
  calendarRouter
);
app.use("/api/prompts", requireAccess, requireRole(["DEV", "ADMIN"]), promptsRouter);
app.use("/api/logs", requireAccess, requireRole(["DEV", "ADMIN"]), logsRouter);
app.use(
  "/api/jobs",
  requireAccess,
  requireRole(["DEV", "ADMIN", "SECRETARY", "BOSS"]),
  schedulerRouter
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[Koyeb1] Unhandled error:", err);
  res.status(500).json({
    error: "Internal Server Error"
  });
});

if (config.ENABLE_SCHEDULER) {
  initScheduler();
}

app.listen(config.PORT, () => {
  console.log(`Koyeb1-ACDC-Core listening on port ${config.PORT}`);
});
