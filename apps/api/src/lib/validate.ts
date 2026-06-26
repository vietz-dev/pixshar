export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const MAX_FILES_PER_UPLOAD = 200;
export const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

// Magic bytes for image type verification (more reliable than client MIME type)
const MAGIC_BYTES: Record<string, number[][]> = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]], // RIFF header — deeper check below
  "image/heic": [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]], // ftyp
  "image/heif": [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]],
};

export function checkMagicBytes(buffer: Buffer, mimeType: string): boolean {
  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return false;
  for (const sig of signatures) {
    if (sig.length > buffer.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (buffer[i] !== sig[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  // WEBP: RIFF header with WEBP at bytes 8-11
  if (mimeType === "image/webp" && buffer.length >= 12) {
    const webp = buffer.slice(8, 12).toString("ascii");
    if (webp === "WEBP") return true;
  }
  return false;
}

// True if the bytes match the magic signature of any allowed image type.
// Used to verify a directly-uploaded original (no declared MIME available).
export function isValidImageBytes(buffer: Buffer): boolean {
  return ALLOWED_MIME_TYPES.some((mime) => checkMagicBytes(buffer, mime));
}

export function validateFiles(files: File[]): { valid: boolean; error?: string } {
  if (files.length > MAX_FILES_PER_UPLOAD) {
    return { valid: false, error: `Maximum ${MAX_FILES_PER_UPLOAD} files per upload` };
  }

  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      return { valid: false, error: `File "${file.name}" exceeds 50MB limit` };
    }
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return { valid: false, error: `File "${file.name}" is not a supported image type (${file.type})` };
    }
  }

  return { valid: true };
}

export async function validateFileMagicBytes(file: File): Promise<{ valid: boolean; error?: string }> {
  const head = Buffer.from(await file.slice(0, 16).arrayBuffer());
  if (!checkMagicBytes(head, file.type)) {
    return { valid: false, error: `File "${file.name}" content does not match its declared type (${file.type})` };
  }
  return { valid: true };
}
