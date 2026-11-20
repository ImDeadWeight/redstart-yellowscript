// Score, lives and bonuses.

export function createScore() {
  return { score: 0, best: 0, combo: 0, gemsTaken: 0, log: [] }
}

/** Points for a gem, more when gems are taken in quick succession. */
export function gemValue(gem, combo) {
  const multiplier = 1 + Math.min(combo, 4) * 0.5
  return Math.round(gem.points * multiplier)
}

/** The player picked up `gem`: count it and add its points. */
export function takeGem(state, gem) {
  if (gem.taken) return 0
  gem.taken = true
  const value = gemValue(gem, state.combo)
  state.combo++
  state.gemsTaken++
  addPoints(state, value)
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
