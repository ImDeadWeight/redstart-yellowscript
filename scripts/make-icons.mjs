/**
 * Writes Redstart Yellowscript's icons into media/ from its mascot drawing
 * (../assets/mascot/redstart-yellowscript.txt: the bird on a yellow pencil).
 *
 *   npm run icons            (or: node scripts/make-icons.mjs [out-folder])
 *
 * Copied from redstart-project redstart-nest/scripts/make-yellowscript-icons.mjs
 * (commit 43c0f52); the output folder now defaults to this repo's media/.
 *
 * - icon.png              256px, the extension's icon (Marketplace, Extensions view)
 * - yellowscript.svg      full colour: the editor tab, the login screen
 * - yellowscript-mono.svg a 24-cell silhouette in currentColor: the activity
 *                         bar, which VS Code draws as a mask
 */

import * as fs from 'fs'
import * as path from 'path'
import { loadMascot, rasterize, contentSquare, encodePng, toSvg, toSilhouetteSvg } from './mascot.mjs'

import { fileURLToPath } from 'url'

const out = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'media')
fs.mkdirSync(out, { recursive: true })
const write = (name, data) => {
  fs.writeFileSync(path.join(out, name), data)
  console.log(`✓ ${name}  (${(Buffer.byteLength(data) / 1024).toFixed(1)} KB)`)
}

const grid = loadMascot('yellowscript')

// Cropped to the drawing, so the bird fills the extension tile.
write('icon.png', encodePng(rasterize(grid, 256, { pad: 8, crop: contentSquare(grid, 2) }), 256))
write('yellowscript.svg', toSvg(grid))

// The eye (its white and grey ring, inside the head) is a hole, so the head
// reads as the bird rather than a blob at 24px.
const eye = (x, y, ch) => y >= 20 && y < 45 && x >= 75 && x < 105 && (ch === 'W' || ch === 'g')
write('yellowscript-mono.svg', toSilhouetteSvg(grid, 24, { hole: eye }))
