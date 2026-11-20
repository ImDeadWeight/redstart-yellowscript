// Picking up gems through the real frame loop must score their points, with
// the combo multiplier, and the tuning tables must be as they were. Run it
// with and without the symbol tools (`--withhold`) to compare prompt tokens.
import { pathToFileURL } from 'node:url'
import { expect, file, pass } from '../_lib/check.mjs'

const load = (rel) => import(pathToFileURL(file(rel)).href).catch((e) => ({ error: e }))
const main = await load('src/main.js')
expect(!main.error, `src/main.js does not load: ${main.error?.message}`)
const tables = await load('src/data/tables.js')
expect(tables.GEM_POINTS?.ruby === 50 && tables.GEM_POINTS?.emerald === 75 && tables.GEM_POINTS?.sapphire === 100, 'the gem point values were changed')

const game = main.createGame(1)
const take = (gem) => {
  game.player.x = gem.x
  game.player.y = gem.y
  main.update(game)
}
const [first, second] = game.gems
take(first)
const firstValue = tables.GEM_POINTS[first.gem]
expect(game.score.score === firstValue, `after one ${first.gem} the score is ${game.score.score}, expected ${firstValue}`)
take(second)
const secondValue = Math.round(tables.GEM_POINTS[second.gem] * 1.5)
expect(game.score.score === firstValue + secondValue, `after a second gem in a combo the score is ${game.score.score}, expected ${firstValue + secondValue}`)
expect(game.score.best === game.score.score, 'the best score did not follow')
pass(`gems score ${firstValue} and ${secondValue}`)
