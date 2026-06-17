import { PrismaClient } from "@prisma/client";

// Enable WAL mode for better concurrent write performance, and increase
// the busy timeout so concurrent uploads don't time out when SQLite
// serializes writes.
export const prisma = new PrismaClient({
  log: [{ level: "warn", emit: "stdout" }, { level: "error", emit: "stdout" }],
  transactionOptions: {
    maxWait: 60000,
    timeout: 60000,
  },
});

// Call before starting the server so WAL mode is active for all requests.
export async function initDatabase() {
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout=30000");
  console.log("SQLite: WAL mode enabled, busy_timeout=30s");
}
