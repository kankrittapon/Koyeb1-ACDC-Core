import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/http";
import { runJobNow } from "./service";

const runJobSchema = z.object({
  jobType: z.enum(["morning_summary", "evening_summary", "event_alert_sweep", "process_due_jobs"])
});

export const schedulerRouter = Router();

schedulerRouter.post(
  "/run",
  asyncHandler(async (req, res) => {
    const body = runJobSchema.parse(req.body);
    const result = await runJobNow(body.jobType);
    return res.json({
      success: true,
      jobType: body.jobType,
      ...result
    });
  })
);
