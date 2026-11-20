// The heads-up display, drawn over the game.

import { COLORS } from '../data/tables.js'

export function drawHud(ctx, state, player, level) {
  ctx.fillStyle = COLORS.hud
  ctx.font = '12px monospace'
  ctx.fillText(`SCORE ${String(state.score).padStart(6, '0')}`, 8, 14)
  ctx.fillText(`BEST ${String(state.best).padStart(6, '0')}`, 120, 14)
  ctx.fillText(`LIVES ${player.lives}`, 240, 14)
  ctx.fillText(level.name.toUpperCase(), 320, 14)
}

export function formatScore(score) {
  return String(score).padStart(6, '0')
}

/** Banner 0: a message shown for a moment after an event. */
export function banner0(ctx, t) {
  const alpha = Math.max(0, 1 - t / 30)
  ctx.globalAlpha = alpha
  ctx.fillText("COMBO!", 100, 60)
  ctx.globalAlpha = 1
}

/** Banner 1: a message shown for a moment after an event. */
export function banner1(ctx, t) {
  const alpha = Math.max(0, 1 - t / 31)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 103, 70)
  ctx.globalAlpha = 1
}

/** Banner 2: a message shown for a moment after an event. */
export function banner2(ctx, t) {
  const alpha = Math.max(0, 1 - t / 32)
  ctx.globalAlpha = alpha
  ctx.fillText("WATCH OUT", 106, 80)
  ctx.globalAlpha = 1
}

/** Banner 3: a message shown for a moment after an event. */
export function banner3(ctx, t) {
  const alpha = Math.max(0, 1 - t / 33)
  ctx.globalAlpha = alpha
  ctx.fillText("FASTER!", 109, 90)
  ctx.globalAlpha = 1
}

/** Banner 4: a message shown for a moment after an event. */
export function banner4(ctx, t) {
  const alpha = Math.max(0, 1 - t / 34)
  ctx.globalAlpha = alpha
  ctx.fillText("WATCH OUT", 112, 100)
  ctx.globalAlpha = 1
}

/** Banner 5: a message shown for a moment after an event. */
export function banner5(ctx, t) {
  const alpha = Math.max(0, 1 - t / 35)
  ctx.globalAlpha = alpha
  ctx.fillText("WATCH OUT", 115, 110)
  ctx.globalAlpha = 1
}

/** Banner 6: a message shown for a moment after an event. */
export function banner6(ctx, t) {
  const alpha = Math.max(0, 1 - t / 36)
  ctx.globalAlpha = alpha
  ctx.fillText("FASTER!", 118, 120)
  ctx.globalAlpha = 1
}

/** Banner 7: a message shown for a moment after an event. */
export function banner7(ctx, t) {
  const alpha = Math.max(0, 1 - t / 37)
  ctx.globalAlpha = alpha
  ctx.fillText("GEM!", 121, 60)
  ctx.globalAlpha = 1
}

/** Banner 8: a message shown for a moment after an event. */
export function banner8(ctx, t) {
  const alpha = Math.max(0, 1 - t / 38)
  ctx.globalAlpha = alpha
  ctx.fillText("LEVEL UP", 124, 70)
  ctx.globalAlpha = 1
}

/** Banner 9: a message shown for a moment after an event. */
export function banner9(ctx, t) {
  const alpha = Math.max(0, 1 - t / 39)
  ctx.globalAlpha = alpha
  ctx.fillText("NICE!", 127, 80)
  ctx.globalAlpha = 1
}

/** Banner 10: a message shown for a moment after an event. */
export function banner10(ctx, t) {
  const alpha = Math.max(0, 1 - t / 40)
  ctx.globalAlpha = alpha
  ctx.fillText("WATCH OUT", 130, 90)
  ctx.globalAlpha = 1
}

/** Banner 11: a message shown for a moment after an event. */
export function banner11(ctx, t) {
  const alpha = Math.max(0, 1 - t / 41)
  ctx.globalAlpha = alpha
  ctx.fillText("LEVEL UP", 133, 100)
  ctx.globalAlpha = 1
}

/** Banner 12: a message shown for a moment after an event. */
export function banner12(ctx, t) {
  const alpha = Math.max(0, 1 - t / 42)
  ctx.globalAlpha = alpha
  ctx.fillText("LEVEL UP", 136, 110)
  ctx.globalAlpha = 1
}

/** Banner 13: a message shown for a moment after an event. */
export function banner13(ctx, t) {
  const alpha = Math.max(0, 1 - t / 43)
  ctx.globalAlpha = alpha
  ctx.fillText("GEM!", 139, 120)
  ctx.globalAlpha = 1
}

/** Banner 14: a message shown for a moment after an event. */
export function banner14(ctx, t) {
  const alpha = Math.max(0, 1 - t / 44)
  ctx.globalAlpha = alpha
  ctx.fillText("WATCH OUT", 142, 60)
  ctx.globalAlpha = 1
}

/** Banner 15: a message shown for a moment after an event. */
export function banner15(ctx, t) {
  const alpha = Math.max(0, 1 - t / 45)
  ctx.globalAlpha = alpha
  ctx.fillText("GEM!", 145, 70)
  ctx.globalAlpha = 1
}

/** Banner 16: a message shown for a moment after an event. */
export function banner16(ctx, t) {
  const alpha = Math.max(0, 1 - t / 46)
  ctx.globalAlpha = alpha
  ctx.fillText("NICE!", 148, 80)
  ctx.globalAlpha = 1
}

/** Banner 17: a message shown for a moment after an event. */
export function banner17(ctx, t) {
  const alpha = Math.max(0, 1 - t / 47)
  ctx.globalAlpha = alpha
  ctx.fillText("LEVEL UP", 151, 90)
  ctx.globalAlpha = 1
}

/** Banner 18: a message shown for a moment after an event. */
export function banner18(ctx, t) {
  const alpha = Math.max(0, 1 - t / 48)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 154, 100)
  ctx.globalAlpha = 1
}

/** Banner 19: a message shown for a moment after an event. */
export function banner19(ctx, t) {
  const alpha = Math.max(0, 1 - t / 49)
  ctx.globalAlpha = alpha
  ctx.fillText("FASTER!", 157, 110)
  ctx.globalAlpha = 1
}

/** Banner 20: a message shown for a moment after an event. */
export function banner20(ctx, t) {
  const alpha = Math.max(0, 1 - t / 50)
  ctx.globalAlpha = alpha
  ctx.fillText("FASTER!", 160, 120)
  ctx.globalAlpha = 1
}

/** Banner 21: a message shown for a moment after an event. */
export function banner21(ctx, t) {
  const alpha = Math.max(0, 1 - t / 51)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 163, 60)
  ctx.globalAlpha = 1
}

/** Banner 22: a message shown for a moment after an event. */
export function banner22(ctx, t) {
  const alpha = Math.max(0, 1 - t / 52)
  ctx.globalAlpha = alpha
  ctx.fillText("WATCH OUT", 166, 70)
  ctx.globalAlpha = 1
}

/** Banner 23: a message shown for a moment after an event. */
export function banner23(ctx, t) {
  const alpha = Math.max(0, 1 - t / 53)
  ctx.globalAlpha = alpha
  ctx.fillText("GEM!", 169, 80)
  ctx.globalAlpha = 1
}

/** Banner 24: a message shown for a moment after an event. */
export function banner24(ctx, t) {
  const alpha = Math.max(0, 1 - t / 54)
  ctx.globalAlpha = alpha
  ctx.fillText("WATCH OUT", 172, 90)
  ctx.globalAlpha = 1
}

/** Banner 25: a message shown for a moment after an event. */
export function banner25(ctx, t) {
  const alpha = Math.max(0, 1 - t / 55)
  ctx.globalAlpha = alpha
  ctx.fillText("COMBO!", 175, 100)
  ctx.globalAlpha = 1
}

/** Banner 26: a message shown for a moment after an event. */
export function banner26(ctx, t) {
  const alpha = Math.max(0, 1 - t / 56)
  ctx.globalAlpha = alpha
  ctx.fillText("LEVEL UP", 178, 110)
  ctx.globalAlpha = 1
}

/** Banner 27: a message shown for a moment after an event. */
export function banner27(ctx, t) {
  const alpha = Math.max(0, 1 - t / 57)
  ctx.globalAlpha = alpha
  ctx.fillText("COMBO!", 181, 120)
  ctx.globalAlpha = 1
}

/** Banner 28: a message shown for a moment after an event. */
export function banner28(ctx, t) {
  const alpha = Math.max(0, 1 - t / 58)
  ctx.globalAlpha = alpha
  ctx.fillText("WATCH OUT", 184, 60)
  ctx.globalAlpha = 1
}

/** Banner 29: a message shown for a moment after an event. */
export function banner29(ctx, t) {
  const alpha = Math.max(0, 1 - t / 59)
  ctx.globalAlpha = alpha
  ctx.fillText("LEVEL UP", 187, 70)
  ctx.globalAlpha = 1
}

/** Banner 30: a message shown for a moment after an event. */
export function banner30(ctx, t) {
  const alpha = Math.max(0, 1 - t / 60)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 190, 80)
  ctx.globalAlpha = 1
}

/** Banner 31: a message shown for a moment after an event. */
export function banner31(ctx, t) {
  const alpha = Math.max(0, 1 - t / 61)
  ctx.globalAlpha = alpha
  ctx.fillText("COMBO!", 193, 90)
  ctx.globalAlpha = 1
}

/** Banner 32: a message shown for a moment after an event. */
export function banner32(ctx, t) {
  const alpha = Math.max(0, 1 - t / 62)
  ctx.globalAlpha = alpha
  ctx.fillText("GEM!", 196, 100)
  ctx.globalAlpha = 1
}

/** Banner 33: a message shown for a moment after an event. */
export function banner33(ctx, t) {
  const alpha = Math.max(0, 1 - t / 63)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 199, 110)
  ctx.globalAlpha = 1
}

/** Banner 34: a message shown for a moment after an event. */
export function banner34(ctx, t) {
  const alpha = Math.max(0, 1 - t / 64)
  ctx.globalAlpha = alpha
  ctx.fillText("GEM!", 202, 120)
  ctx.globalAlpha = 1
}

/** Banner 35: a message shown for a moment after an event. */
export function banner35(ctx, t) {
  const alpha = Math.max(0, 1 - t / 65)
  ctx.globalAlpha = alpha
  ctx.fillText("LEVEL UP", 205, 60)
  ctx.globalAlpha = 1
}

/** Banner 36: a message shown for a moment after an event. */
export function banner36(ctx, t) {
  const alpha = Math.max(0, 1 - t / 66)
  ctx.globalAlpha = alpha
  ctx.fillText("LEVEL UP", 208, 70)
  ctx.globalAlpha = 1
}

/** Banner 37: a message shown for a moment after an event. */
export function banner37(ctx, t) {
  const alpha = Math.max(0, 1 - t / 67)
  ctx.globalAlpha = alpha
  ctx.fillText("NICE!", 211, 80)
  ctx.globalAlpha = 1
}

/** Banner 38: a message shown for a moment after an event. */
export function banner38(ctx, t) {
  const alpha = Math.max(0, 1 - t / 68)
  ctx.globalAlpha = alpha
  ctx.fillText("COMBO!", 214, 90)
  ctx.globalAlpha = 1
}

/** Banner 39: a message shown for a moment after an event. */
export function banner39(ctx, t) {
  const alpha = Math.max(0, 1 - t / 69)
  ctx.globalAlpha = alpha
  ctx.fillText("WATCH OUT", 217, 100)
  ctx.globalAlpha = 1
}

/** Banner 40: a message shown for a moment after an event. */
export function banner40(ctx, t) {
  const alpha = Math.max(0, 1 - t / 70)
  ctx.globalAlpha = alpha
  ctx.fillText("GEM!", 220, 110)
  ctx.globalAlpha = 1
}

/** Banner 41: a message shown for a moment after an event. */
export function banner41(ctx, t) {
  const alpha = Math.max(0, 1 - t / 71)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 223, 120)
  ctx.globalAlpha = 1
}

/** Banner 42: a message shown for a moment after an event. */
export function banner42(ctx, t) {
  const alpha = Math.max(0, 1 - t / 72)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 226, 60)
  ctx.globalAlpha = 1
}

/** Banner 43: a message shown for a moment after an event. */
export function banner43(ctx, t) {
  const alpha = Math.max(0, 1 - t / 73)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 229, 70)
  ctx.globalAlpha = 1
}

/** Banner 44: a message shown for a moment after an event. */
export function banner44(ctx, t) {
  const alpha = Math.max(0, 1 - t / 74)
  ctx.globalAlpha = alpha
  ctx.fillText("WATCH OUT", 232, 80)
  ctx.globalAlpha = 1
}

/** Banner 45: a message shown for a moment after an event. */
export function banner45(ctx, t) {
  const alpha = Math.max(0, 1 - t / 75)
  ctx.globalAlpha = alpha
  ctx.fillText("NICE!", 235, 90)
  ctx.globalAlpha = 1
}

/** Banner 46: a message shown for a moment after an event. */
export function banner46(ctx, t) {
  const alpha = Math.max(0, 1 - t / 76)
  ctx.globalAlpha = alpha
  ctx.fillText("FASTER!", 238, 100)
  ctx.globalAlpha = 1
}

/** Banner 47: a message shown for a moment after an event. */
export function banner47(ctx, t) {
  const alpha = Math.max(0, 1 - t / 77)
  ctx.globalAlpha = alpha
  ctx.fillText("COMBO!", 241, 110)
  ctx.globalAlpha = 1
}

/** Banner 48: a message shown for a moment after an event. */
export function banner48(ctx, t) {
  const alpha = Math.max(0, 1 - t / 78)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 244, 120)
  ctx.globalAlpha = 1
}

/** Banner 49: a message shown for a moment after an event. */
export function banner49(ctx, t) {
  const alpha = Math.max(0, 1 - t / 79)
  ctx.globalAlpha = alpha
  ctx.fillText("COMBO!", 247, 60)
  ctx.globalAlpha = 1
}

/** Banner 50: a message shown for a moment after an event. */
export function banner50(ctx, t) {
  const alpha = Math.max(0, 1 - t / 80)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 250, 70)
  ctx.globalAlpha = 1
}

/** Banner 51: a message shown for a moment after an event. */
export function banner51(ctx, t) {
  const alpha = Math.max(0, 1 - t / 81)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 253, 80)
  ctx.globalAlpha = 1
}

/** Banner 52: a message shown for a moment after an event. */
export function banner52(ctx, t) {
  const alpha = Math.max(0, 1 - t / 82)
  ctx.globalAlpha = alpha
  ctx.fillText("FASTER!", 256, 90)
  ctx.globalAlpha = 1
}

/** Banner 53: a message shown for a moment after an event. */
export function banner53(ctx, t) {
  const alpha = Math.max(0, 1 - t / 83)
  ctx.globalAlpha = alpha
  ctx.fillText("FASTER!", 259, 100)
  ctx.globalAlpha = 1
}

/** Banner 54: a message shown for a moment after an event. */
export function banner54(ctx, t) {
  const alpha = Math.max(0, 1 - t / 84)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 262, 110)
  ctx.globalAlpha = 1
}

/** Banner 55: a message shown for a moment after an event. */
export function banner55(ctx, t) {
  const alpha = Math.max(0, 1 - t / 85)
  ctx.globalAlpha = alpha
  ctx.fillText("GEM!", 265, 120)
  ctx.globalAlpha = 1
}

/** Banner 56: a message shown for a moment after an event. */
export function banner56(ctx, t) {
  const alpha = Math.max(0, 1 - t / 86)
  ctx.globalAlpha = alpha
  ctx.fillText("LEVEL UP", 268, 60)
  ctx.globalAlpha = 1
}

/** Banner 57: a message shown for a moment after an event. */
export function banner57(ctx, t) {
  const alpha = Math.max(0, 1 - t / 87)
  ctx.globalAlpha = alpha
  ctx.fillText("FASTER!", 271, 70)
  ctx.globalAlpha = 1
}

/** Banner 58: a message shown for a moment after an event. */
export function banner58(ctx, t) {
  const alpha = Math.max(0, 1 - t / 88)
  ctx.globalAlpha = alpha
  ctx.fillText("NICE!", 274, 80)
  ctx.globalAlpha = 1
}

/** Banner 59: a message shown for a moment after an event. */
export function banner59(ctx, t) {
  const alpha = Math.max(0, 1 - t / 89)
  ctx.globalAlpha = alpha
  ctx.fillText("COMBO!", 277, 90)
  ctx.globalAlpha = 1
}

/** Banner 60: a message shown for a moment after an event. */
export function banner60(ctx, t) {
  const alpha = Math.max(0, 1 - t / 90)
  ctx.globalAlpha = alpha
  ctx.fillText("GEM!", 280, 100)
  ctx.globalAlpha = 1
}

/** Banner 61: a message shown for a moment after an event. */
export function banner61(ctx, t) {
  const alpha = Math.max(0, 1 - t / 91)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 283, 110)
  ctx.globalAlpha = 1
}

/** Banner 62: a message shown for a moment after an event. */
export function banner62(ctx, t) {
  const alpha = Math.max(0, 1 - t / 92)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 286, 120)
  ctx.globalAlpha = 1
}

/** Banner 63: a message shown for a moment after an event. */
export function banner63(ctx, t) {
  const alpha = Math.max(0, 1 - t / 93)
  ctx.globalAlpha = alpha
  ctx.fillText("COMBO!", 289, 60)
  ctx.globalAlpha = 1
}

/** Banner 64: a message shown for a moment after an event. */
export function banner64(ctx, t) {
  const alpha = Math.max(0, 1 - t / 94)
  ctx.globalAlpha = alpha
  ctx.fillText("LEVEL UP", 292, 70)
  ctx.globalAlpha = 1
}

/** Banner 65: a message shown for a moment after an event. */
export function banner65(ctx, t) {
  const alpha = Math.max(0, 1 - t / 95)
  ctx.globalAlpha = alpha
  ctx.fillText("WATCH OUT", 295, 80)
  ctx.globalAlpha = 1
}

/** Banner 66: a message shown for a moment after an event. */
export function banner66(ctx, t) {
  const alpha = Math.max(0, 1 - t / 96)
  ctx.globalAlpha = alpha
  ctx.fillText("COMBO!", 298, 90)
  ctx.globalAlpha = 1
}

/** Banner 67: a message shown for a moment after an event. */
export function banner67(ctx, t) {
  const alpha = Math.max(0, 1 - t / 97)
  ctx.globalAlpha = alpha
  ctx.fillText("FASTER!", 301, 100)
  ctx.globalAlpha = 1
}

/** Banner 68: a message shown for a moment after an event. */
export function banner68(ctx, t) {
  const alpha = Math.max(0, 1 - t / 98)
  ctx.globalAlpha = alpha
  ctx.fillText("GEM!", 304, 110)
  ctx.globalAlpha = 1
}

/** Banner 69: a message shown for a moment after an event. */
export function banner69(ctx, t) {
  const alpha = Math.max(0, 1 - t / 99)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 307, 120)
  ctx.globalAlpha = 1
}

/** Banner 70: a message shown for a moment after an event. */
export function banner70(ctx, t) {
  const alpha = Math.max(0, 1 - t / 100)
  ctx.globalAlpha = alpha
  ctx.fillText("NICE!", 310, 60)
  ctx.globalAlpha = 1
}

/** Banner 71: a message shown for a moment after an event. */
export function banner71(ctx, t) {
  const alpha = Math.max(0, 1 - t / 101)
  ctx.globalAlpha = alpha
  ctx.fillText("GEM!", 313, 70)
  ctx.globalAlpha = 1
}

/** Banner 72: a message shown for a moment after an event. */
export function banner72(ctx, t) {
  const alpha = Math.max(0, 1 - t / 102)
  ctx.globalAlpha = alpha
  ctx.fillText("NICE!", 316, 80)
  ctx.globalAlpha = 1
}

/** Banner 73: a message shown for a moment after an event. */
export function banner73(ctx, t) {
  const alpha = Math.max(0, 1 - t / 103)
  ctx.globalAlpha = alpha
  ctx.fillText("FASTER!", 319, 90)
  ctx.globalAlpha = 1
}

/** Banner 74: a message shown for a moment after an event. */
export function banner74(ctx, t) {
  const alpha = Math.max(0, 1 - t / 104)
  ctx.globalAlpha = alpha
  ctx.fillText("CLOSE ONE", 322, 100)
  ctx.globalAlpha = 1
}

/** Banner 75: a message shown for a moment after an event. */
export function banner75(ctx, t) {
  const alpha = Math.max(0, 1 - t / 105)
  ctx.globalAlpha = alpha
  ctx.fillText("GEM!", 325, 110)
  ctx.globalAlpha = 1
}

/** Banner 76: a message shown for a moment after an event. */
export function banner76(ctx, t) {
  const alpha = Math.max(0, 1 - t / 106)
  ctx.globalAlpha = alpha
  ctx.fillText("COMBO!", 328, 120)
  ctx.globalAlpha = 1
}

/** Banner 77: a message shown for a moment after an event. */
export function banner77(ctx, t) {
  const alpha = Math.max(0, 1 - t / 107)
  ctx.globalAlpha = alpha
  ctx.fillText("WATCH OUT", 331, 60)
  ctx.globalAlpha = 1
}

/** Banner 78: a message shown for a moment after an event. */
export function banner78(ctx, t) {
  const alpha = Math.max(0, 1 - t / 108)
  ctx.globalAlpha = alpha
  ctx.fillText("WATCH OUT", 334, 70)
  ctx.globalAlpha = 1
}

/** Banner 79: a message shown for a moment after an event. */
export function banner79(ctx, t) {
  const alpha = Math.max(0, 1 - t / 109)
  ctx.globalAlpha = alpha
  ctx.fillText("FASTER!", 337, 80)
  ctx.globalAlpha = 1
}
