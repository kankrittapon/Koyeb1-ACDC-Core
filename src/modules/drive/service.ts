import { google } from "googleapis";
import { config } from "../../config";

let cachedDriveClient: ReturnType<typeof google.drive> | null = null;

function ensureDriveConfig(): void {
  if (
    !config.GOOGLE_DRIVE_CLIENT_ID ||
    !config.GOOGLE_DRIVE_CLIENT_SECRET ||
    !config.GOOGLE_DRIVE_REFRESH_TOKEN
  ) {
    throw new Error("Google Drive credentials are not configured");
  }
}

async function getDriveClient() {
  if (cachedDriveClient) {
    return cachedDriveClient;
  }

  ensureDriveConfig();

  const oauthClient = new google.auth.OAuth2(
    config.GOOGLE_DRIVE_CLIENT_ID,
    config.GOOGLE_DRIVE_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );

  oauthClient.setCredentials({
    refresh_token: config.GOOGLE_DRIVE_REFRESH_TOKEN
  });

  cachedDriveClient = google.drive({
    version: "v3",
    auth: oauthClient
  });

  return cachedDriveClient;
}

export async function uploadFileToDrive(input: {
  fileName: string;
  mimeType: string;
  fileStream: NodeJS.ReadableStream;
  folderId?: string;
}) {
  const drive = await getDriveClient();

  const response = await drive.files.create({
    requestBody: {
      name: input.fileName,
      parents: input.folderId ? [input.folderId] : undefined
    },
    media: {
      mimeType: input.mimeType,
      body: input.fileStream
    },
    fields: "id, webViewLink"
  });

  const fileId = response.data.id;
  if (!fileId) {
    throw new Error("Google Drive upload succeeded without returning a file id");
  }

  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone"
    }
  });

  return {
    id: fileId,
    webViewLink: response.data.webViewLink ?? null
  };
}
