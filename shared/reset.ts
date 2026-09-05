export const RESET_CONFIRMATIONS = {
  activity: 'CLEAR ACTIVITY',
  book: 'START FRESH',
  everything: 'FACTORY RESET',
} as const;

export type ResetScope = keyof typeof RESET_CONFIRMATIONS;

export const RESET_LABELS: Record<ResetScope, string> = {
  activity: 'Clear activity',
  book: 'Start fresh book',
  everything: 'Factory reset',
};
