/** 12-color collaborator palette, assigned round-robin at signup. */
export const USER_COLORS = [
  '#0F6E6E',
  '#B23A3A',
  '#2447F5',
  '#B7791F',
  '#6B3FA0',
  '#2E7D4F',
  '#C2185B',
  '#00838F',
  '#5D4037',
  '#7B1FA2',
  '#EF6C00',
  '#455A64',
] as const;

export function pickColor(index: number): string {
  return USER_COLORS[Math.abs(index) % USER_COLORS.length]!;
}
