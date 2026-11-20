// Tile queries over a level's rows.

export const TILE = 16

export function tileAt(level, x, y) {
  const row = level.rows[y]
  return row === undefined ? '#' : (row[x] ?? '#')
}

export function isSolid(level, x, y) {
  return tileAt(level, x, y) === '#'
}

export function countSolid(level) {
  let n = 0
  for (const row of level.rows) for (const ch of row) if (ch === '#') n++
  return n
}

export function firstSolidInColumn(level, x) {
  for (let y = 0; y < level.rows.length; y++) if (tileAt(level, x, y) === '#') return y
  return -1
}

export function solidCells(level) {
  const cells = []
  level.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') cells.push({ x, y })
  })
  return cells
}

export function isPlatform(level, x, y) {
  return tileAt(level, x, y) === '='
}

export function countPlatform(level) {
  let n = 0
  for (const row of level.rows) for (const ch of row) if (ch === '=') n++
  return n
}

export function firstPlatformInColumn(level, x) {
  for (let y = 0; y < level.rows.length; y++) if (tileAt(level, x, y) === '=') return y
  return -1
}

export function platformCells(level) {
  const cells = []
  level.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '=') cells.push({ x, y })
  })
  return cells
}

export function isLadder(level, x, y) {
  return tileAt(level, x, y) === 'H'
}

export function countLadder(level) {
  let n = 0
  for (const row of level.rows) for (const ch of row) if (ch === 'H') n++
  return n
}

export function firstLadderInColumn(level, x) {
  for (let y = 0; y < level.rows.length; y++) if (tileAt(level, x, y) === 'H') return y
  return -1
}

export function ladderCells(level) {
  const cells = []
  level.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === 'H') cells.push({ x, y })
  })
  return cells
}

export function isSpike(level, x, y) {
  return tileAt(level, x, y) === '^'
}

export function countSpike(level) {
  let n = 0
  for (const row of level.rows) for (const ch of row) if (ch === '^') n++
  return n
}

export function firstSpikeInColumn(level, x) {
  for (let y = 0; y < level.rows.length; y++) if (tileAt(level, x, y) === '^') return y
  return -1
}

export function spikeCells(level) {
  const cells = []
  level.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '^') cells.push({ x, y })
  })
  return cells
}

export function isWater(level, x, y) {
  return tileAt(level, x, y) === '~'
}

export function countWater(level) {
  let n = 0
  for (const row of level.rows) for (const ch of row) if (ch === '~') n++
  return n
}

export function firstWaterInColumn(level, x) {
  for (let y = 0; y < level.rows.length; y++) if (tileAt(level, x, y) === '~') return y
  return -1
}

export function waterCells(level) {
  const cells = []
  level.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '~') cells.push({ x, y })
  })
  return cells
}

export function isEmpty(level, x, y) {
  return tileAt(level, x, y) === '.'
}

export function countEmpty(level) {
  let n = 0
  for (const row of level.rows) for (const ch of row) if (ch === '.') n++
  return n
}

export function firstEmptyInColumn(level, x) {
  for (let y = 0; y < level.rows.length; y++) if (tileAt(level, x, y) === '.') return y
  return -1
}

export function emptyCells(level) {
  const cells = []
  level.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '.') cells.push({ x, y })
  })
  return cells
}

export function blocksMovement(level, x, y) {
  return isSolid(level, x, y)
}

export function standsOn(level, x, y) {
  return isSolid(level, x, y + 1) || isPlatform(level, x, y + 1)
}

/** Region 0: a 4x3 window, used by the minimap. */
export function region0(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 1: a 5x4 window, used by the minimap. */
export function region1(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 2: a 6x5 window, used by the minimap. */
export function region2(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 3: a 7x6 window, used by the minimap. */
export function region3(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 4: a 8x3 window, used by the minimap. */
export function region4(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 5: a 4x4 window, used by the minimap. */
export function region5(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 6: a 5x5 window, used by the minimap. */
export function region6(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 7: a 6x6 window, used by the minimap. */
export function region7(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 8: a 7x3 window, used by the minimap. */
export function region8(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 9: a 8x4 window, used by the minimap. */
export function region9(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 10: a 4x5 window, used by the minimap. */
export function region10(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 11: a 5x6 window, used by the minimap. */
export function region11(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 12: a 6x3 window, used by the minimap. */
export function region12(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 13: a 7x4 window, used by the minimap. */
export function region13(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 14: a 8x5 window, used by the minimap. */
export function region14(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 15: a 4x6 window, used by the minimap. */
export function region15(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 16: a 5x3 window, used by the minimap. */
export function region16(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 17: a 6x4 window, used by the minimap. */
export function region17(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 18: a 7x5 window, used by the minimap. */
export function region18(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 19: a 8x6 window, used by the minimap. */
export function region19(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 20: a 4x3 window, used by the minimap. */
export function region20(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 21: a 5x4 window, used by the minimap. */
export function region21(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 22: a 6x5 window, used by the minimap. */
export function region22(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 23: a 7x6 window, used by the minimap. */
export function region23(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 24: a 8x3 window, used by the minimap. */
export function region24(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 25: a 4x4 window, used by the minimap. */
export function region25(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 26: a 5x5 window, used by the minimap. */
export function region26(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 27: a 6x6 window, used by the minimap. */
export function region27(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 28: a 7x3 window, used by the minimap. */
export function region28(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 29: a 8x4 window, used by the minimap. */
export function region29(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 30: a 4x5 window, used by the minimap. */
export function region30(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 31: a 5x6 window, used by the minimap. */
export function region31(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 32: a 6x3 window, used by the minimap. */
export function region32(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 33: a 7x4 window, used by the minimap. */
export function region33(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 34: a 8x5 window, used by the minimap. */
export function region34(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 35: a 4x6 window, used by the minimap. */
export function region35(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 36: a 5x3 window, used by the minimap. */
export function region36(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 37: a 6x4 window, used by the minimap. */
export function region37(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 38: a 7x5 window, used by the minimap. */
export function region38(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 39: a 8x6 window, used by the minimap. */
export function region39(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 40: a 4x3 window, used by the minimap. */
export function region40(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 41: a 5x4 window, used by the minimap. */
export function region41(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 42: a 6x5 window, used by the minimap. */
export function region42(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 43: a 7x6 window, used by the minimap. */
export function region43(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 44: a 8x3 window, used by the minimap. */
export function region44(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 45: a 4x4 window, used by the minimap. */
export function region45(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 46: a 5x5 window, used by the minimap. */
export function region46(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 47: a 6x6 window, used by the minimap. */
export function region47(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 48: a 7x3 window, used by the minimap. */
export function region48(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 49: a 8x4 window, used by the minimap. */
export function region49(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 50: a 4x5 window, used by the minimap. */
export function region50(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 51: a 5x6 window, used by the minimap. */
export function region51(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 52: a 6x3 window, used by the minimap. */
export function region52(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 53: a 7x4 window, used by the minimap. */
export function region53(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 54: a 8x5 window, used by the minimap. */
export function region54(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 55: a 4x6 window, used by the minimap. */
export function region55(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 56: a 5x3 window, used by the minimap. */
export function region56(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 57: a 6x4 window, used by the minimap. */
export function region57(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 58: a 7x5 window, used by the minimap. */
export function region58(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 59: a 8x6 window, used by the minimap. */
export function region59(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 60: a 4x3 window, used by the minimap. */
export function region60(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 61: a 5x4 window, used by the minimap. */
export function region61(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 62: a 6x5 window, used by the minimap. */
export function region62(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 63: a 7x6 window, used by the minimap. */
export function region63(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 64: a 8x3 window, used by the minimap. */
export function region64(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 65: a 4x4 window, used by the minimap. */
export function region65(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 66: a 5x5 window, used by the minimap. */
export function region66(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 67: a 6x6 window, used by the minimap. */
export function region67(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 6; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 68: a 7x3 window, used by the minimap. */
export function region68(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 3; y++) {
    let line = ''
    for (let x = ox; x < ox + 7; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 69: a 8x4 window, used by the minimap. */
export function region69(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 4; y++) {
    let line = ''
    for (let x = ox; x < ox + 8; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 70: a 4x5 window, used by the minimap. */
export function region70(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 5; y++) {
    let line = ''
    for (let x = ox; x < ox + 4; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

/** Region 71: a 5x6 window, used by the minimap. */
export function region71(level, ox, oy) {
  const out = []
  for (let y = oy; y < oy + 6; y++) {
    let line = ''
    for (let x = ox; x < ox + 5; x++) line += tileAt(level, x, y)
    out.push(line)
  }
  return out
}

