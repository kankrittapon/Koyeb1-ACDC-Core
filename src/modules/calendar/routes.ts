import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/http";
import { supabaseAdmin } from "../../lib/supabase";

const eventSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  dressCode: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  taskDetails: z.string().nullable().optional(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  isAllDay: z.boolean().optional(),
  locationType: z.string().default("INTERNAL"),
  locationDisplayName: z.string().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  createdBy: z.string().default("api")
});

const updateEventSchema = eventSchema.partial();

export const calendarRouter = Router();

calendarRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;

    let query = supabaseAdmin
      .from("calendar_events")
      .select("*")
      .order("start_at", { ascending: true });

    if (from) {
      query = query.gte("start_at", from);
    }
    if (to) {
      query = query.lte("start_at", to);
    }

    const { data, error } = await query;
    if (error) {
      throw error;
    }

    return res.json(data);
  })
);

calendarRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = eventSchema.parse(req.body);

    const { data, error } = await supabaseAdmin
      .from("calendar_events")
      .insert({
        title: body.title,
        description: body.description ?? null,
        dress_code: body.dressCode ?? null,
        note: body.note ?? null,
        task_details: body.taskDetails ?? null,
        start_at: body.startAt,
        end_at: body.endAt,
        is_all_day: body.isAllDay ?? false,
        location_type: body.locationType,
        location_display_name: body.locationDisplayName ?? null,
        owner_user_id: body.ownerUserId ?? null,
        created_by: body.createdBy
      })
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    return res.status(201).json(data);
  })
);

calendarRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const body = updateEventSchema.parse(req.body);
    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString()
    };

    if (body.title !== undefined) updatePayload.title = body.title;
    if (body.description !== undefined) updatePayload.description = body.description;
    if (body.dressCode !== undefined) updatePayload.dress_code = body.dressCode;
    if (body.note !== undefined) updatePayload.note = body.note;
    if (body.taskDetails !== undefined) updatePayload.task_details = body.taskDetails;
    if (body.startAt !== undefined) updatePayload.start_at = body.startAt;
    if (body.endAt !== undefined) updatePayload.end_at = body.endAt;
    if (body.isAllDay !== undefined) updatePayload.is_all_day = body.isAllDay;
    if (body.locationType !== undefined) updatePayload.location_type = body.locationType;
    if (body.locationDisplayName !== undefined) {
      updatePayload.location_display_name = body.locationDisplayName;
    }
    if (body.ownerUserId !== undefined) updatePayload.owner_user_id = body.ownerUserId;
    if (body.createdBy !== undefined) updatePayload.created_by = body.createdBy;

    const { data, error } = await supabaseAdmin
      .from("calendar_events")
      .update(updatePayload)
      .eq("id", req.params.id)
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    return res.json(data);
  })
);

calendarRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { error } = await supabaseAdmin
      .from("calendar_events")
      .delete()
      .eq("id", req.params.id);

    if (error) {
      throw error;
    }

    return res.status(204).send();
  })
);
