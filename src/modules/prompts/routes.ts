import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/http";
import { supabaseAdmin } from "../../lib/supabase";

const personaSchema = z.object({
  role: z.string().min(1),
  greeting: z.string().default(""),
  tone: z.string().default(""),
  behavior: z.string().default("")
});

const updatePromptConfigSchema = z.object({
  systemInstruction: z.string().optional(),
  aiMode: z.string().optional(),
  isActive: z.boolean().optional(),
  personas: z.array(personaSchema).optional()
});

export const promptsRouter = Router();

promptsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [{ data: botConfig, error: botError }, { data: personas, error: personasError }] =
      await Promise.all([
        supabaseAdmin.from("bot_config").select("*").eq("id", "default").single(),
        supabaseAdmin.from("role_personas").select("*").order("role", { ascending: true })
      ]);

    if (botError) {
      throw botError;
    }
    if (personasError) {
      throw personasError;
    }

    return res.json({ botConfig, personas });
  })
);

promptsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const body = updatePromptConfigSchema.parse(req.body);

    if (
      body.systemInstruction !== undefined ||
      body.aiMode !== undefined ||
      body.isActive !== undefined
    ) {
      const { error } = await supabaseAdmin
        .from("bot_config")
        .upsert({
          id: "default",
          system_instruction: body.systemInstruction ?? "คุณคือระบบ ACDC Core Assistant",
          ai_mode: body.aiMode ?? "gateway",
          is_active: body.isActive ?? true,
          updated_at: new Date().toISOString()
        });

      if (error) {
        throw error;
      }
    }

    if (body.personas) {
      for (const persona of body.personas) {
        const { error } = await supabaseAdmin.from("role_personas").upsert({
          role: persona.role,
          greeting: persona.greeting,
          tone: persona.tone,
          behavior: persona.behavior,
          updated_at: new Date().toISOString()
        });

        if (error) {
          throw error;
        }
      }
    }

    return res.json({ success: true });
  })
);
