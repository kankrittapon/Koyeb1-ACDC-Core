import { WebhookEvent } from "@line/bot-sdk";
import { Router } from "express";
import { asyncHandler } from "../../lib/http";
import { handleLineEvent, lineMiddleware } from "./service";

export const lineRouter = Router();

lineRouter.post(
  "/webhooks/line",
  lineMiddleware,
  asyncHandler(async (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];

    await Promise.all(
      events.map(async (event: WebhookEvent) => {
        await handleLineEvent(event);
      })
    );

    return res.status(200).json({
      status: "ok",
      processed: events.length
    });
  })
);
