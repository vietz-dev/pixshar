import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: [{ level: "warn", emit: "stdout" }, { level: "error", emit: "stdout" }],
  transactionOptions: {
    maxWait: 60000,
    timeout: 60000,
  },
});

// Call before starting the server to verify connectivity (fail fast on a bad
// DATABASE_URL / unreachable Postgres).
export async function initDatabase() {
  await prisma.$connect();
  console.log("Postgres: connected");
}
