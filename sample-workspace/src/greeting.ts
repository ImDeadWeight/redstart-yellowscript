// The type error below is DELIBERATE. It gives ws_diagnostics something real to
// report in the Extension Development Host. This file is outside the extension's
// tsconfig include, so `npm run typecheck` never sees it.

export function greet(name: string): string {
  return `Hello, ${name}`
}

// ts(2345): a number is not assignable to a string parameter.
export const broken: string = greet(42)
