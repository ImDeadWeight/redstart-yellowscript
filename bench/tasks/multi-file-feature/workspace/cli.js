import { capitalize, squish } from './src/index.js'

const [flag, ...rest] = process.argv.slice(2)
const text = rest.join(' ')

switch (flag) {
  case '--capitalize':
    console.log(capitalize(text))
    break
  case '--squish':
    console.log(squish(text))
    break
  default:
    console.error('usage: node cli.js --capitalize|--squish <text>')
    process.exit(2)
}
