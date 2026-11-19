import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const PORT = Number(process.env.PORT) || 4317
const root = join(import.meta.dirname, 'public')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0]
  try {
    const body = await readFile(join(root, path))
    res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}).listen(PORT, () => console.log(`serving on http://localhost:${PORT}`))
