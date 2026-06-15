import { Hono } from "hono"
import { auth } from "src/lib/auth.js"


const router = new Hono({ strict: false })

router.all('/auth/**', (c) => {
  return auth.handler(c.req.raw)
})

export default router