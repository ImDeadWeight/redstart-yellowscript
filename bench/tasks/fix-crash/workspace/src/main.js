import { loadScores } from './lib/load.js'
import { summary } from './lib/stats.js'

const scores = loadScores(new URL('../scores.json', import.meta.url))
const s = summary(scores)
console.log(`Players: ${s.count}`)
console.log(`Best: ${s.best.name} (${s.best.points})`)
console.log(`Total: ${s.total}`)
