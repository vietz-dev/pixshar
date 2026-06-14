import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const CONFIG = {
  N: 16384,
  r: 16,
  p: 1,
  dkLen: 64,
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      CONFIG.dkLen,
      { N: CONFIG.N, r: CONFIG.r, p: CONFIG.p, maxmem: 128 * CONFIG.N * CONFIG.r * 2 },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [salt, keyHex] = hash.split(":");
  if (!salt || !keyHex) return false;
  const targetKey = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      CONFIG.dkLen,
      { N: CONFIG.N, r: CONFIG.r, p: CONFIG.p, maxmem: 128 * CONFIG.N * CONFIG.r * 2 },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
  const keyBuf = Buffer.from(keyHex, "hex");
  if (keyBuf.length !== targetKey.length) return false;
  return timingSafeEqual(keyBuf, targetKey);
}
