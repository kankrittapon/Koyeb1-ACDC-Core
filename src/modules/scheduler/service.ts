import cron from "node-cron";
import { config } from "../../config";
import { supabaseAdmin } from "../../lib/supabase";
import { pushTextMessage } from "../line/service";

async function enqueueJob(jobType: string, jobKey: string, payload: Record<string, unknown>, runAt: Date) {
  const { error } = await supabaseAdmin.from("scheduler_jobs").upsert({
    job_type: jobType,
    job_key: jobKey,
    payload,
    status: "pending",
    run_at: runAt.toISOString()
  });

  if (error) {
    throw error;
  }
}

async function runDigestJob(kind: "morning_summary" | "evening_summary"): Promise<number> {
  const now = new Date();
  const { data: bosses, error: bossError } = await supabaseAdmin
    .from("users")
    .select("id, line_user_id, nickname, role")
    .eq("role", "BOSS")
    .eq("is_active", true);

  if (bossError) {
    throw bossError;
  }

  if (!bosses || bosses.length === 0) {
    return 0;
  }

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(now);
  dayEnd.setHours(23, 59, 59, 999);

  let eventQuery = supabaseAdmin
    .from("calendar_events")
    .select("*")
    .order("start_at", { ascending: true });

  if (kind === "morning_summary") {
    eventQuery = eventQuery.gte("start_at", dayStart.toISOString()).lte("start_at", dayEnd.toISOString());
  } else {
    eventQuery = eventQuery.gte("created_at", dayStart.toISOString()).lte("created_at", dayEnd.toISOString());
  }

  const { data: events, error: eventError } = await eventQuery;
  if (eventError) {
    throw eventError;
  }

  const title =
    kind === "morning_summary"
      ? "🌅 สรุปงานประจำวันนี้"
      : "🌆 สรุปรายการใหม่ที่ถูกเพิ่มเข้ามาวันนี้";

  const lines =
    !events || events.length === 0
      ? ["ไม่มีรายการที่ต้องรายงานในขณะนี้ครับ"]
      : events.map((event, index) => {
          const time = new Date(event.start_at).toLocaleTimeString("th-TH", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: config.APP_TIMEZONE
          });
          return `${index + 1}. ${time} - ${event.title}`;
        });

  const message = `${title}\n\n${lines.join("\n")}`;

  for (const boss of bosses) {
    if (boss.line_user_id) {
      await pushTextMessage(boss.line_user_id, message);
    }
  }

  return events?.length ?? 0;
}

async function runEventAlertSweep(): Promise<number> {
  const now = new Date();
  const future = new Date(now.getTime() + 65 * 60 * 1000);
  const thresholds: Record<string, number> = {
    INTERNAL: 15,
    MAJOR_UNIT: 30,
    OUTSIDE: 60
  };

  const { data: events, error: eventError } = await supabaseAdmin
    .from("calendar_events")
    .select("*")
    .gte("start_at", now.toISOString())
    .lte("start_at", future.toISOString())
    .order("start_at", { ascending: true });

  if (eventError) {
    throw eventError;
  }

  const { data: bosses, error: bossError } = await supabaseAdmin
    .from("users")
    .select("line_user_id")
    .eq("role", "BOSS")
    .eq("is_active", true);

  if (bossError) {
    throw bossError;
  }

  let sentCount = 0;

  for (const event of events ?? []) {
    const minutesUntil = Math.round((new Date(event.start_at).getTime() - now.getTime()) / 60000);
    const threshold = thresholds[event.location_type] ?? 15;

    if (minutesUntil < threshold - 3 || minutesUntil > threshold + 3) {
      continue;
    }

    const alertKey = `${event.id}:${threshold}`;
    const { data: existingAlert } = await supabaseAdmin
      .from("event_alert_logs")
      .select("id")
      .eq("alert_key", alertKey)
      .maybeSingle();

    if (existingAlert) {
      continue;
    }

    const message = `⏰ แจ้งเตือนครับ\n\n"${event.title}"\nเวลา ${new Date(event.start_at).toLocaleTimeString("th-TH", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: config.APP_TIMEZONE
    })}\nอีกประมาณ ${minutesUntil} นาที`;

    for (const boss of bosses ?? []) {
      if (boss.line_user_id) {
        await pushTextMessage(boss.line_user_id, message);
      }
    }

    await supabaseAdmin.from("event_alert_logs").insert({
      calendar_event_id: event.id,
      alert_type: "pre_event",
      alert_key: alertKey,
      sent_at: new Date().toISOString()
    });

    sentCount += 1;
  }

  return sentCount;
}

async function processDueJobs(): Promise<number> {
  const { data: jobs, error } = await supabaseAdmin
    .from("scheduler_jobs")
    .select("*")
    .eq("status", "pending")
    .lte("run_at", new Date().toISOString())
    .order("run_at", { ascending: true })
    .limit(20);

  if (error) {
    throw error;
  }

  let processed = 0;

  for (const job of jobs ?? []) {
    await supabaseAdmin
      .from("scheduler_jobs")
      .update({
        status: "running",
        started_at: new Date().toISOString()
      })
      .eq("id", job.id);

    try {
      if (job.job_type === "morning_summary" || job.job_type === "evening_summary") {
        await runDigestJob(job.job_type);
      } else if (job.job_type === "event_alert_sweep") {
        await runEventAlertSweep();
      }

      await supabaseAdmin
        .from("scheduler_jobs")
        .update({
          status: "completed",
          completed_at: new Date().toISOString()
        })
        .eq("id", job.id);

      processed += 1;
    } catch (jobError) {
      await supabaseAdmin
        .from("scheduler_jobs")
        .update({
          status: "failed",
          failure_reason: jobError instanceof Error ? jobError.message : "unknown error"
        })
        .eq("id", job.id);
    }
  }

  return processed;
}

export async function runJobNow(jobType: string): Promise<{ processed: number }> {
  if (jobType === "morning_summary" || jobType === "evening_summary") {
    const processed = await runDigestJob(jobType);
    return { processed };
  }

  if (jobType === "event_alert_sweep") {
    const processed = await runEventAlertSweep();
    return { processed };
  }

  if (jobType === "process_due_jobs") {
    const processed = await processDueJobs();
    return { processed };
  }

  throw new Error(`Unsupported job type: ${jobType}`);
}

export function initScheduler(): void {
  cron.schedule(
    config.MORNING_SUMMARY_CRON,
    () => {
      void enqueueJob("morning_summary", `morning:${new Date().toISOString().slice(0, 10)}`, {}, new Date());
    },
    { timezone: config.APP_TIMEZONE }
  );

  cron.schedule(
    config.EVENING_SUMMARY_CRON,
    () => {
      void enqueueJob("evening_summary", `evening:${new Date().toISOString().slice(0, 10)}`, {}, new Date());
    },
    { timezone: config.APP_TIMEZONE }
  );

  cron.schedule(
    config.EVENT_ALERT_CRON,
    () => {
      void enqueueJob("event_alert_sweep", `event-alert:${new Date().toISOString()}`, {}, new Date());
      void processDueJobs();
    },
    { timezone: config.APP_TIMEZONE }
  );
}
