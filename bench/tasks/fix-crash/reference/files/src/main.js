import { loadScores } from './lib/load.js'
import { summarise } from './lib/stat.js'

const scores = loadScores(new URL('../scores.json', import.meta.url))
const s = summarise(scores)
console.log(`Players: ${s.count}`)
console.log(`Best: ${s.best.name} (${s.best.points})`)
console.log(`Total: ${s.total}`)
