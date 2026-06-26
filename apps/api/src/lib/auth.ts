import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { prisma } from "./prisma.js";
import { env } from "./env.js";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.WEB_URL],
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
  },
  session: {
    cookieCache: {
      enabled: true,
    },
    cookie: {
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      httpOnly: true,
    },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
  },
});
