import { Hono } from "hono"
import { auth } from "../lib/auth.js"

const router = new Hono({ strict: false })

// Mounted at /api/auth — forward every method/path under it to BetterAuth.
router.all("/*", (c) => auth.handler(c.req.raw))

export default router