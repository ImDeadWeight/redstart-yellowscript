// Regenerates this task's workspace and reference (run from the repo root:
// `node bench/tasks/navigate-large/generate.mjs`). Seeded, so the output is
// the same each time; the bulk is level data and small helpers, so the files
// are long the way real ones are, and one line in src/world/scoring.js is wrong.
import fs from 'node:fs'
import path from 'node:path'

const TASK = path.resolve('bench/tasks/navigate-large')
const WS = path.join(TASK, 'workspace')
let seed = 7
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const pick = (list) => list[Math.floor(rand() * list.length)]

function write(rel, text, base = WS) {
  const file = path.join(base, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`)
}

// --- data/levels.js: big level tables ------------------------------------------------
const TILES = ['.', '#', '=', 'H', '^', '~']
function levelRows(w, h) {
  const rows = []
  for (let y = 0; y < h; y++) {
    let row = ''
    for (let x = 0; x < w; x++) row += y === h - 1 ? '#' : rand() < 0.08 ? pick(TILES.slice(1)) : '.'
    rows.push(row)
  }
  return rows
}
let levels = '// Level layouts. Each row is a string of tiles:\n// . empty, # solid, = platform, H ladder, ^ spikes, ~ water.\n\nexport const LEVELS = [\n'
for (let i = 0; i < 20; i++) {
  levels += `  {\n    id: ${i + 1},\n    name: ${JSON.stringify(`${pick(['Rusty', 'Windy', 'Broken', 'Silent', 'Hollow', 'Bright'])} ${pick(['Yard', 'Girders', 'Docks', 'Tower', 'Mine', 'Bridge'])}`)},\n    barrelEvery: ${60 + Math.floor(rand() * 60)},\n    rows: [\n`
  for (const row of levelRows(40, 16)) levels += `      ${JSON.stringify(row)},\n`
  levels += '    ],\n    gems: [\n'
  for (let g = 0; g < 6; g++) levels += `      { x: ${Math.floor(rand() * 38) + 1}, y: ${Math.floor(rand() * 13) + 1}, kind: ${JSON.stringify(pick(['ruby', 'emerald', 'sapphire']))} },\n`
  levels += '    ],\n  },\n'
}
levels += ']\n\nexport function levelById(id) {\n  return LEVELS.find((level) => level.id === id) ?? null\n}\n'
write('src/data/levels.js', levels)

// --- data/tables.js: lookup tables -----------------------------------------------
let tables = '// Tuning tables.\n\n'
tables += 'export const GEM_POINTS = {\n  ruby: 50,\n  emerald: 75,\n  sapphire: 100,\n}\n\n'
tables += 'export const BARREL_SPEEDS = [\n'
for (let i = 0; i < 60; i++) tables += `  ${(1 + rand() * 2).toFixed(2)},\n`
tables += ']\n\nexport const JUMP_CURVE = [\n'
for (let i = 0; i < 80; i++) tables += `  ${(Math.sin((i / 79) * Math.PI) * 24).toFixed(2)},\n`
tables += ']\n\nexport const COLORS = {\n'
for (const name of ['sky', 'ground', 'girder', 'ladder', 'spike', 'water', 'player', 'barrel', 'ruby', 'emerald', 'sapphire', 'hud', 'shadow', 'flash']) tables += `  ${name}: '#${Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0')}',\n`
tables += '}\n'
write('src/data/tables.js', tables)

// --- engine/tiles.js: many small helpers -----------------------------------------
let tiles = "// Tile queries over a level's rows.\n\nexport const TILE = 16\n\n"
tiles += 'export function tileAt(level, x, y) {\n  const row = level.rows[y]\n  return row === undefined ? \'#\' : (row[x] ?? \'#\')\n}\n\n'
const tileKinds = { Solid: "'#'", Platform: "'='", Ladder: "'H'", Spike: "'^'", Water: "'~'", Empty: "'.'" }
for (const [name, ch] of Object.entries(tileKinds)) {
  tiles += `export function is${name}(level, x, y) {\n  return tileAt(level, x, y) === ${ch}\n}\n\n`
  tiles += `export function count${name}(level) {\n  let n = 0\n  for (const row of level.rows) for (const ch of row) if (ch === ${ch}) n++\n  return n\n}\n\n`
  tiles += `export function first${name}InColumn(level, x) {\n  for (let y = 0; y < level.rows.length; y++) if (tileAt(level, x, y) === ${ch}) return y\n  return -1\n}\n\n`
  tiles += `export function ${name.toLowerCase()}Cells(level) {\n  const cells = []\n  level.rows.forEach((row, y) => {\n    for (let x = 0; x < row.length; x++) if (row[x] === ${ch}) cells.push({ x, y })\n  })\n  return cells\n}\n\n`
}
tiles += 'export function blocksMovement(level, x, y) {\n  return isSolid(level, x, y)\n}\n\nexport function standsOn(level, x, y) {\n  return isSolid(level, x, y + 1) || isPlatform(level, x, y + 1)\n}\n\n'
for (let i = 0; i < 72; i++) {
  tiles += `/** Region ${i}: a ${4 + (i % 5)}x${3 + (i % 4)} window, used by the minimap. */\nexport function region${i}(level, ox, oy) {\n  const out = []\n  for (let y = oy; y < oy + ${3 + (i % 4)}; y++) {\n    let line = ''\n    for (let x = ox; x < ox + ${4 + (i % 5)}; x++) line += tileAt(level, x, y)\n    out.push(line)\n  }\n  return out\n}\n\n`
}
write('src/engine/tiles.js', tiles)

// --- engine/input.js -------------------------------------------------------------
let input = '// Keyboard state, read once per frame.\n\nconst held = new Set()\nconst pressed = new Set()\n\n'
input += "export function attach(target) {\n  target.addEventListener('keydown', (e) => {\n    if (!held.has(e.code)) pressed.add(e.code)\n    held.add(e.code)\n  })\n  target.addEventListener('keyup', (e) => held.delete(e.code))\n}\n\n"
input += 'export function isHeld(code) {\n  return held.has(code)\n}\n\nexport function wasPressed(code) {\n  return pressed.has(code)\n}\n\nexport function endFrame() {\n  pressed.clear()\n}\n\n'
input += 'export function press(code) {\n  pressed.add(code)\n  held.add(code)\n}\n\nexport function release(code) {\n  held.delete(code)\n}\n\n'
const bindings = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Enter', 'Escape', 'KeyP', 'KeyM']
input += 'export const BINDINGS = {\n'
for (const b of bindings) input += `  ${b}: ${JSON.stringify(pick(['left', 'right', 'up', 'down', 'jump', 'pause', 'mute', 'start']))},\n`
input += '}\n\n'
for (const b of bindings) input += `export function ${b[0].toLowerCase()}${b.slice(1)}Held() {\n  return isHeld('${b}')\n}\n\n`
write('src/engine/input.js', input)

// --- world/entities.js: player, barrels, gems ------------------------------------
let entities = `// The things that move: the player, barrels, gems.

import { GEM_POINTS, BARREL_SPEEDS, JUMP_CURVE } from '../data/tables.js'
import { isLadder, standsOn, blocksMovement } from '../engine/tiles.js'

export function createPlayer(x, y) {
  return { kind: 'player', x, y, vx: 0, vy: 0, jumpFrame: -1, climbing: false, lives: 3, facing: 1 }
}

export function createBarrel(x, y, index) {
  return { kind: 'barrel', x, y, vx: -BARREL_SPEEDS[index % BARREL_SPEEDS.length], alive: true }
}

export function createGem(x, y, kind) {
  return { kind: 'gem', gem: kind, x, y, taken: false, points: GEM_POINTS[kind] ?? 0 }
}

export function startJump(player, level) {
  if (player.jumpFrame >= 0 || player.climbing) return false
  if (!standsOn(level, Math.round(player.x), Math.round(player.y))) return false
  player.jumpFrame = 0
  return true
}

export function stepJump(player) {
  if (player.jumpFrame < 0) return 0
  const lift = JUMP_CURVE[player.jumpFrame] ?? 0
  player.jumpFrame++
  if (player.jumpFrame >= JUMP_CURVE.length) player.jumpFrame = -1
  return lift
}

export function moveHorizontally(player, level, dir) {
  const nx = player.x + dir * 0.25
  if (blocksMovement(level, Math.round(nx), Math.round(player.y))) return false
  player.x = nx
  player.facing = dir
  return true
}

export function climb(player, level, dir) {
  if (!isLadder(level, Math.round(player.x), Math.round(player.y + (dir > 0 ? 1 : 0)))) {
    player.climbing = false
    return false
  }
  player.climbing = true
  player.y += dir * 0.2
  return true
}

export function rollBarrel(barrel, level) {
  if (!barrel.alive) return
  const nx = barrel.x + barrel.vx * 0.1
  if (blocksMovement(level, Math.round(nx), Math.round(barrel.y))) barrel.vx = -barrel.vx
  else barrel.x = nx
  if (!standsOn(level, Math.round(barrel.x), Math.round(barrel.y))) barrel.y += 0.3
  if (barrel.x < -2 || barrel.y > level.rows.length + 2) barrel.alive = false
}

export function touches(a, b, reach = 0.6) {
  return Math.abs(a.x - b.x) < reach && Math.abs(a.y - b.y) < reach
}
`
for (let i = 0; i < 60; i++) {
  entities += `\n/** Pose ${i} of the player's walk cycle, as offsets for the sprite. */\nexport function walkPose${i}(player) {\n  return { dx: ${(Math.sin(i / 3) * 2).toFixed(2)} * player.facing, dy: ${(Math.cos(i / 3) * 1).toFixed(2)}, frame: ${i % 8} }\n}\n`
}
write('src/world/entities.js', entities)

// --- world/scoring.js: where the bug is ------------------------------------------
const scoring = (buggy) => `// Score, lives and bonuses.

export function createScore() {
  return { score: 0, best: 0, combo: 0, gemsTaken: 0, log: [] }
}

/** Points for a gem, more when gems are taken in quick succession. */
export function gemValue(gem, combo) {
  const multiplier = 1 + Math.min(combo, 4) * 0.5
  return Math.round(gem.points * multiplier)
}

/** The player picked up \`gem\`: count it and add its points. */
export function takeGem(state, gem) {
  if (gem.taken) return 0
  gem.taken = true
  const value = gemValue(gem, state.combo)
  state.combo++
  state.gemsTaken++
  ${buggy ? 'addPoints(state, Math.sign(value))' : 'addPoints(state, value)'}
  state.log.push({ what: 'gem', gem: gem.gem, value })
  return value
}

export function jumpedBarrel(state) {
  addPoints(state, 100)
  state.log.push({ what: 'barrel', value: 100 })
}

export function breakCombo(state) {
  state.combo = 0
}

export function addPoints(state, points) {
  state.score += points
  if (state.score > state.best) state.best = state.score
}

export function loseLife(player, state) {
  player.lives--
  breakCombo(state)
  return player.lives > 0
}
`
write('src/world/scoring.js', scoring(true))
write('src/world/scoring.js', scoring(false), path.join(TASK, 'reference', 'files'))

// --- ui/hud.js ----------------------------------------------------------------
let hud = `// The heads-up display, drawn over the game.

import { COLORS } from '../data/tables.js'

export function drawHud(ctx, state, player, level) {
  ctx.fillStyle = COLORS.hud
  ctx.font = '12px monospace'
  ctx.fillText(\`SCORE \${String(state.score).padStart(6, '0')}\`, 8, 14)
  ctx.fillText(\`BEST \${String(state.best).padStart(6, '0')}\`, 120, 14)
  ctx.fillText(\`LIVES \${player.lives}\`, 240, 14)
  ctx.fillText(level.name.toUpperCase(), 320, 14)
}

export function formatScore(score) {
  return String(score).padStart(6, '0')
}
`
for (let i = 0; i < 80; i++) {
  hud += `\n/** Banner ${i}: a message shown for a moment after an event. */\nexport function banner${i}(ctx, t) {\n  const alpha = Math.max(0, 1 - t / ${30 + i})\n  ctx.globalAlpha = alpha\n  ctx.fillText(${JSON.stringify(pick(['NICE!', 'COMBO!', 'WATCH OUT', 'LEVEL UP', 'GEM!', 'CLOSE ONE', 'FASTER!']))}, ${100 + i * 3}, ${60 + (i % 7) * 10})\n  ctx.globalAlpha = 1\n}\n`
}
write('src/ui/hud.js', hud)

// --- main.js --------------------------------------------------------------------
write('src/main.js', `// Barrel Run: the frame loop that ties the rest together.

import { levelById } from './data/levels.js'
import { attach, endFrame, isHeld, wasPressed } from './engine/input.js'
import { createBarrel, createGem, createPlayer, climb, moveHorizontally, rollBarrel, startJump, stepJump, touches } from './world/entities.js'
import { createScore, jumpedBarrel, loseLife, takeGem } from './world/scoring.js'
import { drawHud } from './ui/hud.js'

export function createGame(levelId = 1) {
  const level = levelById(levelId)
  return {
    level,
    player: createPlayer(2, level.rows.length - 2),
    barrels: [],
    gems: level.gems.map((g) => createGem(g.x, g.y, g.kind)),
    score: createScore(),
    frame: 0,
  }
}

export function update(game) {
  const { level, player } = game
  if (isHeld('ArrowLeft')) moveHorizontally(player, level, -1)
  if (isHeld('ArrowRight')) moveHorizontally(player, level, 1)
  if (isHeld('ArrowUp')) climb(player, level, -1)
  if (wasPressed('Space')) startJump(player, level)
  player.y -= stepJump(player) / 16
  if (game.frame % level.barrelEvery === 0) game.barrels.push(createBarrel(level.rows[0].length - 2, 1, game.frame))
  for (const barrel of game.barrels) {
    rollBarrel(barrel, level)
    if (barrel.alive && touches(player, barrel)) {
      barrel.alive = false
      if (player.jumpFrame >= 0) jumpedBarrel(game.score)
      else loseLife(player, game.score)
    }
  }
  for (const gem of game.gems) if (!gem.taken && touches(player, gem)) takeGem(game.score, gem)
  game.frame++
  endFrame()
}

export function start(canvas) {
  const ctx = canvas.getContext('2d')
  const game = createGame()
  attach(window)
  window.__game = game
  const tick = () => {
    update(game)
    drawHud(ctx, game.score, game.player, game.level)
    requestAnimationFrame(tick)
  }
  tick()
}
`)
write('index.html', '<!doctype html>\n<title>Barrel Run</title>\n<canvas id="game" width="640" height="256"></canvas>\n<script type="module">import { start } from "./src/main.js"; start(document.getElementById("game"))</script>\n')
write('package.json', '{ "name": "barrel-run", "type": "module", "private": true }')

let total = 0
const count = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) count(p)
    else if (p.endsWith('.js')) total += fs.readFileSync(p, 'utf8').split('\n').length
  }
}
count(path.join(WS, 'src'))
console.log('lines', total)
