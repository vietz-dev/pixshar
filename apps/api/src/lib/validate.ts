export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const MAX_FILES_PER_UPLOAD = 20;
export const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

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
