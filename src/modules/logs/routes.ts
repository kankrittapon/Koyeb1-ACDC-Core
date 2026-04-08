import { Router } from "express";
import { asyncHandler } from "../../lib/http";
import { supabaseAdmin } from "../../lib/supabase";

export const logsRouter = Router();

logsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const limit = Math.min(
      Number.parseInt(typeof req.query.limit === "string" ? req.query.limit : "50", 10) || 50,
      200
    );

    const { data, error } = await supabaseAdmin
      .from("conversation_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw error;
    }

    return res.json(data);
  })
);
