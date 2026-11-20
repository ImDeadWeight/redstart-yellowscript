// Barrel Run: the frame loop that ties the rest together.

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
