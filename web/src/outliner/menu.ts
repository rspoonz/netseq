import { reactive } from "vue";

// The menu a right-click (or a long press, on Android) on a bullet opens, and the phone
// toolbar's ⋯ button (iPhones don't report long presses).
export const bulletMenu = reactive({ id: null as string | null, x: 0, y: 0, above: false });

/** Opens at (x, y): its top-left corner there, or with `above` its bottom-right (for the toolbar). */
export function openBulletMenu(id: string, x: number, y: number, above = false): void {
  Object.assign(bulletMenu, { id, x, y, above });
}

export function closeBulletMenu(): void {
  bulletMenu.id = null;
}
