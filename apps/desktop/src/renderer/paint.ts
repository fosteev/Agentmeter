export function hatch(color: string): string {
  return `repeating-linear-gradient(115deg, ${color} 0 3px, color-mix(in oklch, ${color} 32%, transparent) 3px 7px)`
}
