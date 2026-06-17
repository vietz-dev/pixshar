import { Hono } from "hono"
import { auth } from "src/lib/auth.js"


const router = new Hono({ strict: false })

router.all('**', (c) => {
  console.log(c.req.raw);
  return auth.handler(c.req.raw)
})

export default router