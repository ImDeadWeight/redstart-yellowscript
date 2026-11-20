// The things that move: the player, barrels, gems.

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

/** Pose 0 of the player's walk cycle, as offsets for the sprite. */
export function walkPose0(player) {
  return { dx: 0.00 * player.facing, dy: 1.00, frame: 0 }
}

/** Pose 1 of the player's walk cycle, as offsets for the sprite. */
export function walkPose1(player) {
  return { dx: 0.65 * player.facing, dy: 0.94, frame: 1 }
}

/** Pose 2 of the player's walk cycle, as offsets for the sprite. */
export function walkPose2(player) {
  return { dx: 1.24 * player.facing, dy: 0.79, frame: 2 }
}

/** Pose 3 of the player's walk cycle, as offsets for the sprite. */
export function walkPose3(player) {
  return { dx: 1.68 * player.facing, dy: 0.54, frame: 3 }
}

/** Pose 4 of the player's walk cycle, as offsets for the sprite. */
export function walkPose4(player) {
  return { dx: 1.94 * player.facing, dy: 0.24, frame: 4 }
}

/** Pose 5 of the player's walk cycle, as offsets for the sprite. */
export function walkPose5(player) {
  return { dx: 1.99 * player.facing, dy: -0.10, frame: 5 }
}

/** Pose 6 of the player's walk cycle, as offsets for the sprite. */
export function walkPose6(player) {
  return { dx: 1.82 * player.facing, dy: -0.42, frame: 6 }
}

/** Pose 7 of the player's walk cycle, as offsets for the sprite. */
export function walkPose7(player) {
  return { dx: 1.45 * player.facing, dy: -0.69, frame: 7 }
}

/** Pose 8 of the player's walk cycle, as offsets for the sprite. */
export function walkPose8(player) {
  return { dx: 0.91 * player.facing, dy: -0.89, frame: 0 }
}

/** Pose 9 of the player's walk cycle, as offsets for the sprite. */
export function walkPose9(player) {
  return { dx: 0.28 * player.facing, dy: -0.99, frame: 1 }
}

/** Pose 10 of the player's walk cycle, as offsets for the sprite. */
export function walkPose10(player) {
  return { dx: -0.38 * player.facing, dy: -0.98, frame: 2 }
}

/** Pose 11 of the player's walk cycle, as offsets for the sprite. */
export function walkPose11(player) {
  return { dx: -1.00 * player.facing, dy: -0.87, frame: 3 }
}

/** Pose 12 of the player's walk cycle, as offsets for the sprite. */
export function walkPose12(player) {
  return { dx: -1.51 * player.facing, dy: -0.65, frame: 4 }
}

/** Pose 13 of the player's walk cycle, as offsets for the sprite. */
export function walkPose13(player) {
  return { dx: -1.86 * player.facing, dy: -0.37, frame: 5 }
}

/** Pose 14 of the player's walk cycle, as offsets for the sprite. */
export function walkPose14(player) {
  return { dx: -2.00 * player.facing, dy: -0.05, frame: 6 }
}

/** Pose 15 of the player's walk cycle, as offsets for the sprite. */
export function walkPose15(player) {
  return { dx: -1.92 * player.facing, dy: 0.28, frame: 7 }
}

/** Pose 16 of the player's walk cycle, as offsets for the sprite. */
export function walkPose16(player) {
  return { dx: -1.63 * player.facing, dy: 0.58, frame: 0 }
}

/** Pose 17 of the player's walk cycle, as offsets for the sprite. */
export function walkPose17(player) {
  return { dx: -1.16 * player.facing, dy: 0.82, frame: 1 }
}

/** Pose 18 of the player's walk cycle, as offsets for the sprite. */
export function walkPose18(player) {
  return { dx: -0.56 * player.facing, dy: 0.96, frame: 2 }
}

/** Pose 19 of the player's walk cycle, as offsets for the sprite. */
export function walkPose19(player) {
  return { dx: 0.10 * player.facing, dy: 1.00, frame: 3 }
}

/** Pose 20 of the player's walk cycle, as offsets for the sprite. */
export function walkPose20(player) {
  return { dx: 0.75 * player.facing, dy: 0.93, frame: 4 }
}

/** Pose 21 of the player's walk cycle, as offsets for the sprite. */
export function walkPose21(player) {
  return { dx: 1.31 * player.facing, dy: 0.75, frame: 5 }
}

/** Pose 22 of the player's walk cycle, as offsets for the sprite. */
export function walkPose22(player) {
  return { dx: 1.73 * player.facing, dy: 0.50, frame: 6 }
}

/** Pose 23 of the player's walk cycle, as offsets for the sprite. */
export function walkPose23(player) {
  return { dx: 1.97 * player.facing, dy: 0.19, frame: 7 }
}

/** Pose 24 of the player's walk cycle, as offsets for the sprite. */
export function walkPose24(player) {
  return { dx: 1.98 * player.facing, dy: -0.15, frame: 0 }
}

/** Pose 25 of the player's walk cycle, as offsets for the sprite. */
export function walkPose25(player) {
  return { dx: 1.77 * player.facing, dy: -0.46, frame: 1 }
}

/** Pose 26 of the player's walk cycle, as offsets for the sprite. */
export function walkPose26(player) {
  return { dx: 1.38 * player.facing, dy: -0.73, frame: 2 }
}

/** Pose 27 of the player's walk cycle, as offsets for the sprite. */
export function walkPose27(player) {
  return { dx: 0.82 * player.facing, dy: -0.91, frame: 3 }
}

/** Pose 28 of the player's walk cycle, as offsets for the sprite. */
export function walkPose28(player) {
  return { dx: 0.18 * player.facing, dy: -1.00, frame: 4 }
}

/** Pose 29 of the player's walk cycle, as offsets for the sprite. */
export function walkPose29(player) {
  return { dx: -0.48 * player.facing, dy: -0.97, frame: 5 }
}

/** Pose 30 of the player's walk cycle, as offsets for the sprite. */
export function walkPose30(player) {
  return { dx: -1.09 * player.facing, dy: -0.84, frame: 6 }
}

/** Pose 31 of the player's walk cycle, as offsets for the sprite. */
export function walkPose31(player) {
  return { dx: -1.58 * player.facing, dy: -0.61, frame: 7 }
}

/** Pose 32 of the player's walk cycle, as offsets for the sprite. */
export function walkPose32(player) {
  return { dx: -1.89 * player.facing, dy: -0.32, frame: 0 }
}

/** Pose 33 of the player's walk cycle, as offsets for the sprite. */
export function walkPose33(player) {
  return { dx: -2.00 * player.facing, dy: 0.00, frame: 1 }
}

/** Pose 34 of the player's walk cycle, as offsets for the sprite. */
export function walkPose34(player) {
  return { dx: -1.89 * player.facing, dy: 0.33, frame: 2 }
}

/** Pose 35 of the player's walk cycle, as offsets for the sprite. */
export function walkPose35(player) {
  return { dx: -1.57 * player.facing, dy: 0.62, frame: 3 }
}

/** Pose 36 of the player's walk cycle, as offsets for the sprite. */
export function walkPose36(player) {
  return { dx: -1.07 * player.facing, dy: 0.84, frame: 4 }
}

/** Pose 37 of the player's walk cycle, as offsets for the sprite. */
export function walkPose37(player) {
  return { dx: -0.46 * player.facing, dy: 0.97, frame: 5 }
}

/** Pose 38 of the player's walk cycle, as offsets for the sprite. */
export function walkPose38(player) {
  return { dx: 0.20 * player.facing, dy: 0.99, frame: 6 }
}

/** Pose 39 of the player's walk cycle, as offsets for the sprite. */
export function walkPose39(player) {
  return { dx: 0.84 * player.facing, dy: 0.91, frame: 7 }
}

/** Pose 40 of the player's walk cycle, as offsets for the sprite. */
export function walkPose40(player) {
  return { dx: 1.39 * player.facing, dy: 0.72, frame: 0 }
}

/** Pose 41 of the player's walk cycle, as offsets for the sprite. */
export function walkPose41(player) {
  return { dx: 1.78 * player.facing, dy: 0.45, frame: 1 }
}

/** Pose 42 of the player's walk cycle, as offsets for the sprite. */
export function walkPose42(player) {
  return { dx: 1.98 * player.facing, dy: 0.14, frame: 2 }
}

/** Pose 43 of the player's walk cycle, as offsets for the sprite. */
export function walkPose43(player) {
  return { dx: 1.96 * player.facing, dy: -0.19, frame: 3 }
}

/** Pose 44 of the player's walk cycle, as offsets for the sprite. */
export function walkPose44(player) {
  return { dx: 1.73 * player.facing, dy: -0.51, frame: 4 }
}

/** Pose 45 of the player's walk cycle, as offsets for the sprite. */
export function walkPose45(player) {
  return { dx: 1.30 * player.facing, dy: -0.76, frame: 5 }
}

/** Pose 46 of the player's walk cycle, as offsets for the sprite. */
export function walkPose46(player) {
  return { dx: 0.73 * player.facing, dy: -0.93, frame: 6 }
}

/** Pose 47 of the player's walk cycle, as offsets for the sprite. */
export function walkPose47(player) {
  return { dx: 0.08 * player.facing, dy: -1.00, frame: 7 }
}

/** Pose 48 of the player's walk cycle, as offsets for the sprite. */
export function walkPose48(player) {
  return { dx: -0.58 * player.facing, dy: -0.96, frame: 0 }
}

/** Pose 49 of the player's walk cycle, as offsets for the sprite. */
export function walkPose49(player) {
  return { dx: -1.17 * player.facing, dy: -0.81, frame: 1 }
}

/** Pose 50 of the player's walk cycle, as offsets for the sprite. */
export function walkPose50(player) {
  return { dx: -1.64 * player.facing, dy: -0.57, frame: 2 }
}

/** Pose 51 of the player's walk cycle, as offsets for the sprite. */
export function walkPose51(player) {
  return { dx: -1.92 * player.facing, dy: -0.28, frame: 3 }
}

/** Pose 52 of the player's walk cycle, as offsets for the sprite. */
export function walkPose52(player) {
  return { dx: -2.00 * player.facing, dy: 0.05, frame: 4 }
}

/** Pose 53 of the player's walk cycle, as offsets for the sprite. */
export function walkPose53(player) {
  return { dx: -1.85 * player.facing, dy: 0.38, frame: 5 }
}

/** Pose 54 of the player's walk cycle, as offsets for the sprite. */
export function walkPose54(player) {
  return { dx: -1.50 * player.facing, dy: 0.66, frame: 6 }
}

/** Pose 55 of the player's walk cycle, as offsets for the sprite. */
export function walkPose55(player) {
  return { dx: -0.99 * player.facing, dy: 0.87, frame: 7 }
}

/** Pose 56 of the player's walk cycle, as offsets for the sprite. */
export function walkPose56(player) {
  return { dx: -0.36 * player.facing, dy: 0.98, frame: 0 }
}

/** Pose 57 of the player's walk cycle, as offsets for the sprite. */
export function walkPose57(player) {
  return { dx: 0.30 * player.facing, dy: 0.99, frame: 1 }
}

/** Pose 58 of the player's walk cycle, as offsets for the sprite. */
export function walkPose58(player) {
  return { dx: 0.93 * player.facing, dy: 0.89, frame: 2 }
}

/** Pose 59 of the player's walk cycle, as offsets for the sprite. */
export function walkPose59(player) {
  return { dx: 1.46 * player.facing, dy: 0.68, frame: 3 }
}
