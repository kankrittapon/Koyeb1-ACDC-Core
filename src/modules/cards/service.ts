import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function generateScheduleCard(input: {
  dateLabel: string;
  events: Array<{
    start: string;
    end: string;
    title: string;
    location?: string;
    description?: string;
  }>;
  qrUrl: string;
}): Promise<{ fileName: string; absolutePath: string; publicPath: string }> {
  const publicDir = path.join(process.cwd(), "public", "images");
  await fs.mkdir(publicDir, { recursive: true });

  const fileName = `${randomUUID()}.png`;
  const absolutePath = path.join(publicDir, fileName);
  const scriptPath = path.join(process.cwd(), "src", "scripts", "generate_card.py");

  await execFileAsync("python", [
    scriptPath,
    "--date",
    input.dateLabel,
    "--events",
    JSON.stringify(input.events),
    "--url",
    input.qrUrl,
    "--output",
    absolutePath
  ]);

  return {
    fileName,
    absolutePath,
    publicPath: `/images/${fileName}`
  };
}
