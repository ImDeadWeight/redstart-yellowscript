// Keyboard state, read once per frame.

const held = new Set()
const pressed = new Set()

export function attach(target) {
  target.addEventListener('keydown', (e) => {
    if (!held.has(e.code)) pressed.add(e.code)
    held.add(e.code)
  })
  target.addEventListener('keyup', (e) => held.delete(e.code))
}

export function isHeld(code) {
  return held.has(code)
}

export function wasPressed(code) {
  return pressed.has(code)
}

export function endFrame() {
  pressed.clear()
}

export function press(code) {
  pressed.add(code)
  held.add(code)
}

export function release(code) {
  held.delete(code)
}

export const BINDINGS = {
  ArrowLeft: "right",
  ArrowRight: "start",
  ArrowUp: "jump",
  ArrowDown: "mute",
  Space: "mute",
  KeyA: "mute",
  KeyD: "pause",
  KeyW: "mute",
  KeyS: "right",
  Enter: "mute",
  Escape: "right",
  KeyP: "jump",
  KeyM: "start",
}

export function arrowLeftHeld() {
  return isHeld('ArrowLeft')
}

export function arrowRightHeld() {
  return isHeld('ArrowRight')
}

export function arrowUpHeld() {
  return isHeld('ArrowUp')
}

export function arrowDownHeld() {
  return isHeld('ArrowDown')
}

export function spaceHeld() {
  return isHeld('Space')
}

export function keyAHeld() {
  return isHeld('KeyA')
}

export function keyDHeld() {
  return isHeld('KeyD')
}

export function keyWHeld() {
  return isHeld('KeyW')
}

export function keySHeld() {
  return isHeld('KeyS')
}

export function enterHeld() {
  return isHeld('Enter')
}

export function escapeHeld() {
  return isHeld('Escape')
}

export function keyPHeld() {
  return isHeld('KeyP')
}

export function keyMHeld() {
  return isHeld('KeyM')
}

