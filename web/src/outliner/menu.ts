import { reactive } from "vue";

// The menu a right-click (or a long press, on Android) on a bullet opens, the phone toolbar's ⋯
// button (iPhones don't report long presses), and the ⋯ beside a zoomed-in block's trail.

/** Which corner of the menu sits at (x, y): the pointer's spot, or the corner of a ⋯ button. */
export type MenuCorner = "top-left" | "top-right" | "bottom-right";

export const bulletMenu = reactive({ id: null as string | null, x: 0, y: 0, corner: "top-left" as MenuCorner });

/** Opens with its `corner` at (x, y): top-left at the pointer, bottom-right above the toolbar, top-right below a button at the right. */
export function openBulletMenu(id: string, x: number, y: number, corner: MenuCorner = "top-left"): void {
  Object.assign(bulletMenu, { id, x, y, corner });
}

export function closeBulletMenu(): void {
  bulletMenu.id = null;
}
