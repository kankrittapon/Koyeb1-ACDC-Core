import { randomUUID } from "crypto";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
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
  driveFileId?: string | null;
  driveUrl: string | null;
  localDiskUrl: string | null;
  localDiskPath: string | null;
  storedFileName: string | null;
  sizeBytes: number | null;
  userId?: string | null;
  lineUserId?: string | null;
  reviewStatus?: string | null;
  reviewRequestedToUserId?: string | null;
  reviewTargetUserId?: string | null;
  reviewReason?: string | null;
  reviewMessage?: string | null;
  driveSyncStatus?: string | null;
  driveSyncError?: string | null;
  createdAt?: string | null;
  previewText?: string | null;
  summaryShort?: string | null;
  pageCount?: number | null;
  extractionStatus?: string | null;
  extractionError?: string | null;
};

const richFileSelect =
  "id,user_id,line_user_id,file_name,original_file_name,mime_type,drive_file_id,drive_url,local_disk_url,local_disk_path,stored_file_name,size_bytes,review_status,review_requested_to_user_id,review_target_user_id,review_reason,review_message,drive_sync_status,drive_sync_error,created_at,preview_text,summary_short,page_count,extraction_status,extraction_error";

type UploadedFileExtraction = {
  previewText: string | null;
  summaryShort: string | null;
  pageCount: number | null;
  extractionStatus: "pending" | "completed" | "unsupported" | "failed";
  extractionError: string | null;
};

const execFileAsync = promisify(execFile);

function mapRichUploadedFile(row: Record<string, unknown>): UploadedFileRecord {
  return {
    id: String(row.id),
    fileName: (row.file_name as string) ?? "",
    originalFileName: (row.original_file_name as string | null | undefined) ?? null,
    mimeType: (row.mime_type as string | null | undefined) ?? null,
    driveFileId: (row.drive_file_id as string | null | undefined) ?? null,
    driveUrl: (row.drive_url as string | null | undefined) ?? null,
    localDiskUrl: (row.local_disk_url as string | null | undefined) ?? null,
    localDiskPath: (row.local_disk_path as string | null | undefined) ?? null,
    storedFileName: (row.stored_file_name as string | null | undefined) ?? null,
    sizeBytes: (row.size_bytes as number | null | undefined) ?? null,
    userId: (row.user_id as string | null | undefined) ?? null,
    lineUserId: (row.line_user_id as string | null | undefined) ?? null,
    reviewStatus: (row.review_status as string | null | undefined) ?? null,
    reviewRequestedToUserId: (row.review_requested_to_user_id as string | null | undefined) ?? null,
    reviewTargetUserId: (row.review_target_user_id as string | null | undefined) ?? null,
    reviewReason: (row.review_reason as string | null | undefined) ?? null,
    reviewMessage: (row.review_message as string | null | undefined) ?? null,
    driveSyncStatus: (row.drive_sync_status as string | null | undefined) ?? null,
    driveSyncError: (row.drive_sync_error as string | null | undefined) ?? null,
    createdAt: (row.created_at as string | null | undefined) ?? null,
    previewText: (row.preview_text as string | null | undefined) ?? null,
    summaryShort: (row.summary_short as string | null | undefined) ?? null,
    pageCount: (row.page_count as number | null | undefined) ?? null,
    extractionStatus: (row.extraction_status as string | null | undefined) ?? null,
    extractionError: (row.extraction_error as string | null | undefined) ?? null
  };
}

function buildExtractionSidecarPath(localDiskPath: string): string {
  return `${localDiskPath}.ai.json`;
}

function normalizePreviewText(text: string, maxLength = 4000): string {
  return text.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function buildSummaryFromPreview(previewText: string): string | null {
  const lines = previewText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  const summary = lines.slice(0, 3).join(" | ");
  return summary.slice(0, 280);
}

function canExtractTextPreview(fileName: string, mimeType: string): boolean {
  const normalizedMime = mimeType.toLowerCase();
  const ext = path.extname(fileName).toLowerCase();

  if (normalizedMime.startsWith("text/")) {
    return true;
  }

  if (["application/json", "application/xml"].includes(normalizedMime)) {
    return true;
  }

  return [".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".log", ".xml", ".yml", ".yaml"].includes(ext);
}

function canExtractStructuredDocumentPreview(fileName: string, mimeType: string): boolean {
  const normalizedMime = mimeType.toLowerCase();
  const ext = path.extname(fileName).toLowerCase();

  return (
    normalizedMime.includes("pdf") ||
    normalizedMime.includes("wordprocessingml.document") ||
    normalizedMime.startsWith("image/") ||
    ext === ".pdf" ||
    ext === ".docx" ||
    [".jpg", ".jpeg", ".png", ".webp"].includes(ext)
  );
}

function extractPreviewFromBuffer(input: {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}): UploadedFileExtraction {
  if (!canExtractTextPreview(input.fileName, input.mimeType)) {
    return {
      previewText: null,
      summaryShort: null,
      pageCount: null,
      extractionStatus: "unsupported",
      extractionError: "preview extraction is not supported for this file type yet"
    };
  }

  try {
    const previewText = normalizePreviewText(input.buffer.toString("utf8"));
    if (!previewText) {
      return {
        previewText: null,
        summaryShort: null,
        pageCount: 1,
        extractionStatus: "completed",
        extractionError: null
      };
    }

    return {
      previewText,
      summaryShort: buildSummaryFromPreview(previewText),
      pageCount: 1,
      extractionStatus: "completed",
      extractionError: null
    };
  } catch (error) {
    return {
      previewText: null,
      summaryShort: null,
      pageCount: null,
      extractionStatus: "failed",
      extractionError: error instanceof Error ? error.message.slice(0, 500) : "preview extraction failed"
    };
  }
}

async function writeExtractionSidecar(localDiskPath: string, extraction: UploadedFileExtraction) {
  const sidecarPath = buildExtractionSidecarPath(localDiskPath);
  await fs.promises.writeFile(
    sidecarPath,
    JSON.stringify(
      {
        preview_text: extraction.previewText,
        summary_short: extraction.summaryShort,
        page_count: extraction.pageCount,
        extraction_status: extraction.extractionStatus,
        extraction_error: extraction.extractionError,
        updated_at: new Date().toISOString()
      },
      null,
      2
    ),
    "utf8"
  );
}

async function readExtractionSidecar(localDiskPath: string): Promise<UploadedFileExtraction | null> {
  try {
    const raw = await fs.promises.readFile(buildExtractionSidecarPath(localDiskPath), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      previewText: (parsed.preview_text as string | null | undefined) ?? null,
      summaryShort: (parsed.summary_short as string | null | undefined) ?? null,
      pageCount: (parsed.page_count as number | null | undefined) ?? null,
      extractionStatus:
        ((parsed.extraction_status as UploadedFileExtraction["extractionStatus"] | undefined) ?? "pending"),
      extractionError: (parsed.extraction_error as string | null | undefined) ?? null
    };
  } catch {
    return null;
  }
}

async function persistExtractionToDatabase(id: string, extraction: UploadedFileExtraction) {
  const update = await supabaseAdmin
    .from("uploaded_files")
    .update({
      preview_text: extraction.previewText,
      summary_short: extraction.summaryShort,
      page_count: extraction.pageCount,
      extraction_status: extraction.extractionStatus,
      extraction_error: extraction.extractionError,
      updated_at: new Date().toISOString()
    })
    .eq("id", id);

  if (update.error && update.error.code !== "PGRST204" && update.error.code !== "42703") {
    throw update.error;
  }
}

async function extractStructuredDocumentPreview(input: {
  filePath: string;
}): Promise<UploadedFileExtraction> {
  try {
    const scriptPath = path.join(process.cwd(), "src", "scripts", "extract_file_preview.py");
    const { stdout } = await execFileAsync("python3", [scriptPath, input.filePath], {
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      previewText: (parsed.preview_text as string | null | undefined) ?? null,
      summaryShort: (parsed.summary_short as string | null | undefined) ?? null,
      pageCount: (parsed.page_count as number | null | undefined) ?? null,
      extractionStatus:
        ((parsed.extraction_status as UploadedFileExtraction["extractionStatus"] | undefined) ?? "completed"),
      extractionError: (parsed.extraction_error as string | null | undefined) ?? null
    };
  } catch (error) {
    return {
      previewText: null,
      summaryShort: null,
      pageCount: null,
      extractionStatus: "failed",
      extractionError: error instanceof Error ? error.message.slice(0, 500) : "structured preview extraction failed"
    };
  }
}

async function enrichUploadedFileWithExtraction(record: UploadedFileRecord): Promise<UploadedFileRecord> {
  if (record.previewText || record.summaryShort || record.extractionStatus) {
    return record;
  }

  if (!record.localDiskPath) {
    return record;
  }

  const extraction = await readExtractionSidecar(record.localDiskPath);
  if (!extraction) {
    return record;
  }

  return {
    ...record,
    previewText: extraction.previewText,
    summaryShort: extraction.summaryShort,
    pageCount: extraction.pageCount,
    extractionStatus: extraction.extractionStatus,
    extractionError: extraction.extractionError
  };
}

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

  const richResponse = await supabaseAdmin
    .from("uploaded_files")
    .insert(richInsert)
    .select(richFileSelect)
    .single();

  if (!richResponse.error && richResponse.data) {
    return mapRichUploadedFile(richResponse.data as unknown as Record<string, unknown>);
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
    driveFileId: null,
    localDiskUrl: input.local.publicUrl,
    localDiskPath: input.local.absolutePath,
    storedFileName: input.local.storedFileName,
    sizeBytes: input.local.sizeBytes,
    userId: input.userId,
    lineUserId: input.lineUserId,
    reviewStatus: null,
    reviewRequestedToUserId: null,
    reviewTargetUserId: null,
    reviewReason: null,
    reviewMessage: null,
    previewText: null,
    summaryShort: null,
    pageCount: null,
    extractionStatus: null,
    extractionError: null
  };
}

export async function extractUploadedFilePreview(input: {
  id: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  localDiskPath: string;
}): Promise<UploadedFileExtraction> {
  const extraction = canExtractStructuredDocumentPreview(input.fileName, input.mimeType)
    ? await extractStructuredDocumentPreview({
        filePath: input.localDiskPath
      })
    : extractPreviewFromBuffer({
        fileName: input.fileName,
        mimeType: input.mimeType,
        buffer: input.buffer
      });

  await writeExtractionSidecar(input.localDiskPath, extraction);

  try {
    await persistExtractionToDatabase(input.id, extraction);
  } catch {
    // Sidecar is the source of truth for phase 2; DB persistence is best-effort.
  }

  return extraction;
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
    .select(richFileSelect)
    .single();

  if (!richUpdate.error && richUpdate.data) {
    return mapRichUploadedFile(richUpdate.data as unknown as Record<string, unknown>) satisfies UploadedFileRecord;
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
    driveFileId: input.driveFileId,
    localDiskUrl: null,
    localDiskPath: null,
    storedFileName: null,
    sizeBytes: null,
    userId: null,
    lineUserId: null,
    reviewStatus: null,
    reviewRequestedToUserId: null,
    reviewTargetUserId: null,
    reviewReason: null,
    reviewMessage: null
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
    .select(richFileSelect)
    .eq("line_user_id", lineUserId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!richResponse.error) {
    const row = richResponse.data;
    if (!row) {
      return null;
    }
    return enrichUploadedFileWithExtraction(
      mapRichUploadedFile(row as unknown as Record<string, unknown>)
    );
  }

  const legacyResponse = await supabaseAdmin
    .from("uploaded_files")
    .select("id,file_name,mime_type,drive_file_id,drive_url")
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

  return enrichUploadedFileWithExtraction({
    id: legacyResponse.data.id,
    fileName: legacyResponse.data.file_name,
    originalFileName: null,
    mimeType: legacyResponse.data.mime_type ?? null,
    driveFileId: legacyResponse.data.drive_file_id ?? null,
    driveUrl: legacyResponse.data.drive_url ?? null,
    localDiskUrl: null,
    localDiskPath: null,
    storedFileName: null,
    sizeBytes: null,
    userId: null,
    lineUserId: lineUserId,
    reviewStatus: null,
    reviewRequestedToUserId: null,
    reviewTargetUserId: null,
    reviewReason: null,
    reviewMessage: null,
    previewText: null,
    summaryShort: null,
    pageCount: null,
    extractionStatus: null,
    extractionError: null
  });
}

export async function getUploadedFileById(id: string): Promise<UploadedFileRecord | null> {
  const response = await supabaseAdmin
    .from("uploaded_files")
    .select(richFileSelect)
    .eq("id", id)
    .maybeSingle();

  if (!response.error) {
    if (!response.data) {
      return null;
    }

    const row = response.data;
    return enrichUploadedFileWithExtraction(
      mapRichUploadedFile(row as unknown as Record<string, unknown>)
    );
  }

  const legacyResponse = await supabaseAdmin
    .from("uploaded_files")
    .select("id,user_id,line_user_id,file_name,original_file_name,mime_type,drive_file_id,drive_url,local_disk_url,local_disk_path,stored_file_name,size_bytes")
    .eq("id", id)
    .maybeSingle();

  if (legacyResponse.error) {
    throw response.error ?? legacyResponse.error;
  }

  if (!legacyResponse.data) {
    return null;
  }

  const row = legacyResponse.data;
  return enrichUploadedFileWithExtraction({
    id: row.id,
    fileName: row.file_name,
    originalFileName: row.original_file_name ?? null,
    mimeType: row.mime_type ?? null,
    driveFileId: row.drive_file_id ?? null,
    driveUrl: row.drive_url ?? null,
    localDiskUrl: row.local_disk_url ?? null,
    localDiskPath: row.local_disk_path ?? null,
    storedFileName: row.stored_file_name ?? null,
    sizeBytes: row.size_bytes ?? null,
    userId: row.user_id ?? null,
    lineUserId: row.line_user_id ?? null,
    reviewStatus: null,
    reviewRequestedToUserId: null,
    reviewTargetUserId: null,
    reviewReason: null,
    reviewMessage: null,
    driveSyncStatus: null,
    driveSyncError: null,
    createdAt: null,
    previewText: null,
    summaryShort: null,
    pageCount: null,
    extractionStatus: null,
    extractionError: null
  });
}

export async function getRecentUploadedFilesForLineUser(
  lineUserId: string,
  limit = 5
): Promise<UploadedFileRecord[]> {
  const richResponse = await supabaseAdmin
    .from("uploaded_files")
    .select(richFileSelect)
    .eq("line_user_id", lineUserId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!richResponse.error) {
    return Promise.all(
      (richResponse.data ?? []).map((row) =>
        enrichUploadedFileWithExtraction(mapRichUploadedFile(row as unknown as Record<string, unknown>))
      )
    );
  }

  const legacyResponse = await supabaseAdmin
    .from("uploaded_files")
    .select("id,file_name,mime_type,drive_file_id,drive_url,created_at")
    .eq("line_user_id", lineUserId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (legacyResponse.error) {
    throw richResponse.error ?? legacyResponse.error;
  }

  return Promise.all(
    (legacyResponse.data ?? []).map((row) =>
      enrichUploadedFileWithExtraction({
        id: row.id,
        fileName: row.file_name,
        originalFileName: null,
        mimeType: row.mime_type ?? null,
        driveFileId: row.drive_file_id ?? null,
        driveUrl: row.drive_url ?? null,
        localDiskUrl: null,
        localDiskPath: null,
        storedFileName: null,
        sizeBytes: null,
        userId: null,
        lineUserId,
        reviewStatus: null,
        reviewRequestedToUserId: null,
        reviewTargetUserId: null,
        reviewReason: null,
        reviewMessage: null,
        driveSyncStatus: null,
        driveSyncError: null,
        createdAt: row.created_at ?? null,
        previewText: null,
        summaryShort: null,
        pageCount: null,
        extractionStatus: null,
        extractionError: null
      })
    )
  );
}

export async function updateUploadedFileReviewState(input: {
  id: string;
  reviewStatus: string;
  reviewRequestedToUserId?: string | null;
  reviewTargetUserId?: string | null;
  reviewMessage?: string | null;
  reviewReason?: string | null;
}) {
  const update = await supabaseAdmin
    .from("uploaded_files")
    .update({
      review_status: input.reviewStatus,
      review_requested_to_user_id: input.reviewRequestedToUserId ?? null,
      review_target_user_id: input.reviewTargetUserId ?? null,
      review_message: input.reviewMessage ?? null,
      review_reason: input.reviewReason ?? null,
      updated_at: new Date().toISOString()
    })
    .eq("id", input.id);

  if (update.error && update.error.code !== "PGRST204") {
    throw update.error;
  }
}

export function bufferToReadable(buffer: Buffer): NodeJS.ReadableStream {
  return Readable.from(buffer);
}

export async function getAllUploadedFilesForLineUser(lineUserId: string): Promise<UploadedFileRecord[]> {
  return getRecentUploadedFilesForLineUser(lineUserId, 1000);
}

export async function deleteUploadedFileRecord(id: string): Promise<void> {
  const response = await supabaseAdmin.from("uploaded_files").delete().eq("id", id);
  if (response.error) {
    throw response.error;
  }
}

export async function removeStoredFileArtifacts(localDiskPath: string | null | undefined): Promise<void> {
  if (!localDiskPath) {
    return;
  }

  const sidecarPath = buildExtractionSidecarPath(localDiskPath);

  await fs.promises.rm(localDiskPath, { force: true });
  await fs.promises.rm(sidecarPath, { force: true });
}

export async function removeExtractionSidecar(localDiskPath: string | null | undefined): Promise<void> {
  if (!localDiskPath) {
    return;
  }

  const sidecarPath = buildExtractionSidecarPath(localDiskPath);
  await fs.promises.rm(sidecarPath, { force: true });
}
