export const APP_NAME = '墨页 Moye';
export const APP_SHORT_NAME = '墨页';
// Keep this stable across renames so pinned shortcuts continue to group.
export const APP_ID = 'HanHan.TyporaReplica';
export const LEGACY_DATA_DIRECTORY = 'Typora Replica';
export const THEMES = [['light', '白色'], ['dark', '夜间'], ['workbuddy', 'WorkBuddy 深色'], ['copilot', 'Copilot 深色'], ['transparent', '透明']] as const;
export type Theme = typeof THEMES[number][0];
export function isTheme(value: unknown): value is Theme { return THEMES.some(([id]) => id === value); }
export const WINDOW_OPACITY = { min: 65, max: 90, default: 74 } as const;
export function windowOpacity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(WINDOW_OPACITY.min, Math.min(WINDOW_OPACITY.max, value)))
    : WINDOW_OPACITY.default;
}
