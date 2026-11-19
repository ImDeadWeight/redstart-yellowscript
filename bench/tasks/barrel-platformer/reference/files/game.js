// Girder Run — a compact reference for the milestone check: four sloped
// girders, ladders, rolling barrels, jumping, lives, and a goal at the top.
const canvas = document.getElementById('game')
const ctx = canvas.getContext('2d')
const W = 800, H = 600

// Each girder slopes from (x1, y1) to (x2, y2).
const girders = [
  { x1: 0, y1: 560, x2: 800, y2: 540 },
  { x1: 60, y1: 420, x2: 800, y2: 440 },
  { x1: 0, y1: 320, x2: 740, y2: 300 },
  { x1: 60, y1: 180, x2: 800, y2: 200 },
]
const ladders = [
  { x: 700, top: 0, bottom: 1 },
  { x: 120, top: 1, bottom: 2 },
  { x: 650, top: 2, bottom: 3 },
]
const goal = { x: 380, y: 140, w: 40, h: 40 }

const girderY = (g, x) => g.y1 + ((g.y2 - g.y1) * (x - g.x1)) / (g.x2 - g.x1)
const player = { x: 40, y: 0, vy: 0, level: 0, climbing: null, onGround: true }
let barrels = []
let score = 0
let lives = 3
let state = 'play'
let spawnTimer = 0
const keys = new Set()

addEventListener('keydown', (e) => {
  keys.add(e.key)
  if (e.key === ' ' && player.onGround && !player.climbing) {
    player.vy = -7
    player.onGround = false
  }
  if (state !== 'play' && e.key === 'Enter') reset(true)
})
addEventListener('keyup', (e) => keys.delete(e.key))

function reset(full) {
  player.x = 40
  player.level = 0
  player.climbing = null
  player.vy = 0
  player.y = girderY(girders[0], player.x) - 20
  barrels = []
  if (full) {
    lives = 3
    score = 0
    state = 'play'
  }
}

function ladderAt(level, up) {
  return ladders.find((l) => (up ? l.top === level : l.bottom === level) && Math.abs(player.x - l.x) < 12)
}

function updatePlayer() {
  if (player.climbing) {
    const l = player.climbing
    const top = girderY(girders[l.bottom], l.x) - 20
    const bottom = girderY(girders[l.top], l.x) - 20
    if (keys.has('ArrowUp')) player.y -= 2
    if (keys.has('ArrowDown')) player.y += 2
    if (player.y <= top) { player.level = l.bottom; player.climbing = null; player.y = top }
    if (player.y >= bottom) { player.level = l.top; player.climbing = null; player.y = bottom }
    return
  }
  if (keys.has('ArrowLeft')) player.x -= 3
  if (keys.has('ArrowRight')) player.x += 3
  player.x = Math.max(10, Math.min(W - 10, player.x))
  if (keys.has('ArrowUp') && player.onGround) {
    const l = ladderAt(player.level, true)
    if (l) { player.climbing = l; player.x = l.x }
  } else if (keys.has('ArrowDown') && player.onGround) {
    const l = ladderAt(player.level, false)
    if (l) { player.climbing = l; player.x = l.x }
  }
  const floor = girderY(girders[player.level], player.x) - 20
  player.vy += 0.4
  player.y += player.vy
  if (player.y >= floor) { player.y = floor; player.vy = 0; player.onGround = true }
}

function updateBarrels() {
  if (--spawnTimer <= 0) {
    barrels.push({ x: 780, level: 3, dir: -1, jumped: false, falling: null })
    spawnTimer = 120 + Math.random() * 80
  }
  for (const b of barrels) {
    if (b.falling) {
      b.y += 4
      const target = girderY(girders[b.falling.top], b.x) - 10
      if (b.y >= target) { b.level = b.falling.top; b.falling = null; b.dir *= -1 }
      continue
    }
    b.x += 2.5 * b.dir
    b.y = girderY(girders[b.level], b.x) - 10
    const down = ladders.find((l) => l.bottom === b.level && Math.abs(b.x - l.x) < 2)
    if (down && Math.random() < 0.3) b.falling = down
    if (b.x < 10 || b.x > W - 10) {
      if (b.level === 0) b.dead = true
      else { b.level--; b.dir *= -1 }
    }
    if (!b.jumped && b.level === player.level && Math.abs(b.x - player.x) < 10 && player.y < b.y - 20) {
      b.jumped = true
      score++
    }
    if (Math.abs(b.x - player.x) < 14 && Math.abs(b.y - (player.y + 10)) < 16) {
      lives--
      if (lives <= 0) state = 'lost'
      else reset(false)
      return
    }
  }
  barrels = barrels.filter((b) => !b.dead)
}

function draw() {
  ctx.fillStyle = '#0b0b14'
  ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = '#d0463b'
  ctx.lineWidth = 8
  for (const g of girders) {
    ctx.beginPath()
    ctx.moveTo(g.x1, g.y1)
    ctx.lineTo(g.x2, g.y2)
    ctx.stroke()
  }
  ctx.strokeStyle = '#4fb3d9'
  ctx.lineWidth = 3
  for (const l of ladders) {
    const top = girderY(girders[l.bottom], l.x), bottom = girderY(girders[l.top], l.x)
    ctx.strokeRect(l.x - 8, top, 16, bottom - top)
  }
  ctx.fillStyle = '#f2c14e'
  ctx.fillRect(goal.x, goal.y, goal.w, goal.h)
  ctx.fillStyle = '#8b5a2b'
  for (const b of barrels) {
    ctx.beginPath()
    ctx.arc(b.x, b.y, 10, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = '#7ee081'
  ctx.fillRect(player.x - 8, player.y, 16, 20)
  ctx.fillStyle = '#fff'
  ctx.font = '18px monospace'
  ctx.fillText(`Score ${score}   Lives ${lives}`, 16, 28)
  if (state !== 'play') {
    ctx.font = '40px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(state === 'won' ? 'You made it!' : 'Game over', W / 2, H / 2)
    ctx.font = '18px monospace'
    ctx.fillText('Enter to play again', W / 2, H / 2 + 34)
    ctx.textAlign = 'start'
  }
}

function loop() {
  if (state === 'play') {
    updatePlayer()
    updateBarrels()
    if (player.level === 3 && Math.abs(player.x - (goal.x + goal.w / 2)) < 30) state = 'won'
  }
  draw()
  requestAnimationFrame(loop)
}

reset(true)
requestAnimationFrame(loop)
