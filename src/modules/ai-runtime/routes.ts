import { Router } from "express";
import { asyncHandler } from "../../lib/http";
import { probeOpenClawRuntime } from "./service";

export const aiRuntimeRouter = Router();

aiRuntimeRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const result = await probeOpenClawRuntime();
    return res.json(result);
  })
);
