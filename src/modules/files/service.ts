import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { config } from "../../config";
import { supabaseAdmin } from "../../lib/supabase";

export type StoredLocalFile = {
  originalFileName: string;
  storedFileName: string;
  mimeType: string;
  sizeBytes: number;
  absolutePath: string;
  relativePath: string;
  publicPath: string;
  publicUrl: string | null;
};

function buildPublicPathFromRelativePath(relativePath: string): string {
  return `/uploads/${normalizeRelativePath(relativePath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export type UploadedFileRecord = {
  id: string;
  fileName: string;
  originalFileName: string | null;
  mimeType: string | null;
  driveUrl: string | null;
  localDiskUrl: string | null;
  localDiskPath: string | null;
  storedFileName: string | null;
  sizeBytes: number | null;
};

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, " ").trim();
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function extensionForUpload(fileName: string, mimeType: string): string {
  const ext = path.extname(fileName);
  if (ext) {
    return ext.toLowerCase();
  }

  const mimeMap: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/msword": ".doc"
  };

  return mimeMap[mimeType] ?? ".bin";
}

export async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function saveIncomingFileToDisk(input: {
  buffer: Buffer;
  originalFileName: string;
  mimeType: string;
  role: string;
}) : Promise<StoredLocalFile> {
  const date = new Date();
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const roleDir = input.role.toLowerCase();

  const safeOriginalName = sanitizeFileName(input.originalFileName || "upload");
  const ext = extensionForUpload(safeOriginalName, input.mimeType);
  const stem = path.basename(safeOriginalName, path.extname(safeOriginalName)) || "upload";
  const storedFileName = `${stem}-${randomUUID()}${ext}`;
  const relativePath = path.join(y, m, d, roleDir, storedFileName);
  const absolutePath = path.join(config.FILE_STORAGE_ROOT, relativePath);

  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.promises.writeFile(absolutePath, input.buffer);

  const publicPath = buildPublicPathFromRelativePath(relativePath);
  return {
    originalFileName: safeOriginalName,
    storedFileName,
    mimeType: input.mimeType,
    sizeBytes: input.buffer.byteLength,
    absolutePath,
    relativePath: normalizeRelativePath(relativePath),
    publicPath,
    publicUrl: config.PUBLIC_BASE_URL ? `${config.PUBLIC_BASE_URL}${publicPath}` : null
  };
}

type UploadedFileInsertContext = {
  userId: string | null;
  lineUserId: string;
  lineMessageId?: string | null;
  sourceProvider?: string;
  fileName: string;
  mimeType: string;
  local: StoredLocalFile;
};

export async function createUploadedFileRecord(
  input: UploadedFileInsertContext
): Promise<UploadedFileRecord> {
  const richInsert = {
    user_id: input.userId,
    line_user_id: input.lineUserId,
    source_provider: input.sourceProvider ?? "line",
    line_message_id: input.lineMessageId ?? null,
    file_name: input.fileName,
    original_file_name: input.local.originalFileName,
    stored_file_name: input.local.storedFileName,
    mime_type: input.mimeType,
    size_bytes: input.local.sizeBytes,
    local_disk_path: input.local.absolutePath,
    local_disk_url: input.local.publicUrl,
    drive_sync_status: "pending",
    updated_at: new Date().toISOString()
  };

  const richSelect =
    "id,file_name,original_file_name,mime_type,drive_url,local_disk_url,local_disk_path,stored_file_name,size_bytes";

  const richResponse = await supabaseAdmin
    .from("uploaded_files")
    .insert(richInsert)
    .select(richSelect)
    .single();

  if (!richResponse.error && richResponse.data) {
    return {
      id: richResponse.data.id,
      fileName: richResponse.data.file_name,
      originalFileName: richResponse.data.original_file_name ?? null,
      mimeType: richResponse.data.mime_type ?? null,
      driveUrl: richResponse.data.drive_url ?? null,
      localDiskUrl: richResponse.data.local_disk_url ?? null,
      localDiskPath: richResponse.data.local_disk_path ?? null,
      storedFileName: richResponse.data.stored_file_name ?? null,
      sizeBytes: richResponse.data.size_bytes ?? null
    };
  }

  const legacyResponse = await supabaseAdmin
    .from("uploaded_files")
    .insert({
      user_id: input.userId,
      line_user_id: input.lineUserId,
      file_name: input.fileName,
      mime_type: input.mimeType,
      drive_file_id: null,
      drive_url: null
    })
    .select("id,file_name,mime_type,drive_url")
    .single();

  if (legacyResponse.error || !legacyResponse.data) {
    throw richResponse.error ?? legacyResponse.error ?? new Error("Unable to create uploaded file record");
  }

  return {
    id: legacyResponse.data.id,
    fileName: legacyResponse.data.file_name,
    originalFileName: input.local.originalFileName,
    mimeType: legacyResponse.data.mime_type ?? null,
    driveUrl: legacyResponse.data.drive_url ?? null,
    localDiskUrl: input.local.publicUrl,
    localDiskPath: input.local.absolutePath,
    storedFileName: input.local.storedFileName,
    sizeBytes: input.local.sizeBytes
  };
}

export async function markUploadedFileDriveSynced(input: {
  id: string;
  driveFileId: string | null;
  driveUrl: string | null;
}) {
  const richUpdate = await supabaseAdmin
    .from("uploaded_files")
    .update({
      drive_file_id: input.driveFileId,
      drive_url: input.driveUrl,
      drive_sync_status: "synced",
      drive_sync_error: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", input.id)
    .select("id,file_name,original_file_name,mime_type,drive_url,local_disk_url,local_disk_path,stored_file_name,size_bytes")
    .single();

  if (!richUpdate.error && richUpdate.data) {
    return {
      id: richUpdate.data.id,
      fileName: richUpdate.data.file_name,
      originalFileName: richUpdate.data.original_file_name ?? null,
      mimeType: richUpdate.data.mime_type ?? null,
      driveUrl: richUpdate.data.drive_url ?? null,
      localDiskUrl: richUpdate.data.local_disk_url ?? null,
      localDiskPath: richUpdate.data.local_disk_path ?? null,
      storedFileName: richUpdate.data.stored_file_name ?? null,
      sizeBytes: richUpdate.data.size_bytes ?? null
    } satisfies UploadedFileRecord;
  }

  const legacyUpdate = await supabaseAdmin
    .from("uploaded_files")
    .update({
      drive_file_id: input.driveFileId,
      drive_url: input.driveUrl
    })
    .eq("id", input.id)
    .select("id,file_name,mime_type,drive_url")
    .single();

  if (legacyUpdate.error || !legacyUpdate.data) {
    throw richUpdate.error ?? legacyUpdate.error ?? new Error("Unable to update uploaded file record");
  }

  return {
    id: legacyUpdate.data.id,
    fileName: legacyUpdate.data.file_name,
    originalFileName: null,
    mimeType: legacyUpdate.data.mime_type ?? null,
    driveUrl: legacyUpdate.data.drive_url ?? null,
    localDiskUrl: null,
    localDiskPath: null,
    storedFileName: null,
    sizeBytes: null
  } satisfies UploadedFileRecord;
}

export async function markUploadedFileDriveFailed(input: { id: string; errorMessage: string }) {
  const richUpdate = await supabaseAdmin
    .from("uploaded_files")
    .update({
      drive_sync_status: "failed",
      drive_sync_error: input.errorMessage.slice(0, 500),
      updated_at: new Date().toISOString()
    })
    .eq("id", input.id);

  if (richUpdate.error && richUpdate.error.code !== "PGRST204") {
    throw richUpdate.error;
  }
}

export async function getLatestUploadedFileForLineUser(lineUserId: string): Promise<UploadedFileRecord | null> {
  const richResponse = await supabaseAdmin
    .from("uploaded_files")
    .select("id,file_name,original_file_name,mime_type,drive_url,local_disk_url,local_disk_path,stored_file_name,size_bytes")
    .eq("line_user_id", lineUserId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!richResponse.error) {
    const row = richResponse.data;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      fileName: row.file_name,
      originalFileName: row.original_file_name ?? null,
      mimeType: row.mime_type ?? null,
      driveUrl: row.drive_url ?? null,
      localDiskUrl: row.local_disk_url ?? null,
      localDiskPath: row.local_disk_path ?? null,
      storedFileName: row.stored_file_name ?? null,
      sizeBytes: row.size_bytes ?? null
    };
  }

  const legacyResponse = await supabaseAdmin
    .from("uploaded_files")
    .select("id,file_name,mime_type,drive_url")
    .eq("line_user_id", lineUserId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (legacyResponse.error) {
    throw richResponse.error ?? legacyResponse.error;
  }

  if (!legacyResponse.data) {
    return null;
  }

  return {
    id: legacyResponse.data.id,
    fileName: legacyResponse.data.file_name,
    originalFileName: null,
    mimeType: legacyResponse.data.mime_type ?? null,
    driveUrl: legacyResponse.data.drive_url ?? null,
    localDiskUrl: null,
    localDiskPath: null,
    storedFileName: null,
    sizeBytes: null
  };
}

export function bufferToReadable(buffer: Buffer): NodeJS.ReadableStream {
  return Readable.from(buffer);
}
