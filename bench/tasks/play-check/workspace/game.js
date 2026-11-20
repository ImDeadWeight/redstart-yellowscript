// Hop: a one-screen game. Run (ArrowLeft/ArrowRight) and jump (Space).

const canvas = document.getElementById('game')
const ctx = canvas.getContext('2d')
const GROUND = 260

// ?test: seeded random numbers and a fixed timestep, so the same keys give
// the same numbers every run (see AGENTS.md).
const testMode = new URLSearchParams(location.search).has('test')
let seed = 1
const random = testMode ? () => ((seed = (seed * 16807) % 2147483647) / 2147483647) : Math.random

const game = {
  scene: 'playing',
  level: 1,
  lives: 3,
  score: 0,
  player: { x: 40, y: GROUND, vx: 0, vy: 0, onGround: true },
  stars: Array.from({ length: 20 }, () => ({ x: random() * 400, y: random() * 200 })),
}
window.__game = game

const held = new Set()

function jump() {
  const p = game.player
  if (!p.onGround) return
  p.vy = -320
  p.onGround = false
}

addEventListener('keydown', (e) => {
  held.add(e.code)
  if (e.key === 'Spacebar') jump()
})
addEventListener('keyup', (e) => held.delete(e.code))

function step(dt) {
  const p = game.player
  p.vx = (held.has('ArrowRight') ? 120 : 0) - (held.has('ArrowLeft') ? 120 : 0)
  p.x = Math.max(0, Math.min(384, p.x + p.vx * dt))
  p.vy += 900 * dt
  p.y += p.vy * dt
  if (p.y >= GROUND) {
    p.y = GROUND
    p.vy = 0
    p.onGround = true
  }
}

function draw() {
  ctx.fillStyle = '#0b1020'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#fff'
  for (const s of game.stars) ctx.fillRect(s.x, s.y, 2, 2)
  ctx.fillStyle = '#3a5'
  ctx.fillRect(0, GROUND + 16, canvas.width, canvas.height)
  ctx.fillStyle = '#fc3'
  ctx.fillRect(game.player.x, game.player.y, 16, 16)
}

let last = performance.now()
function frame(now) {
  const dt = testMode ? 1 / 60 : Math.min(0.05, (now - last) / 1000)
  last = now
  step(dt)
  draw()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
