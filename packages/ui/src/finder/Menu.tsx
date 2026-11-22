import type { ReactElement } from "react";

import { Menu, type MenuItem } from "@kos/kit";

export type { MenuItem };

/**
 * The file manager's menu: what a right click on a row, the menu key or the
 * ⋯ in the toolbar opens, for whatever is selected. The kit's one `Menu`, at
 * the point it was asked for.
 */
export function FinderMenu({ at, items, onClose, label }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void; label: string }): ReactElement {
  return <Menu open at={at} items={items} onClose={onClose} label={label} className="finder-menu" />;
}
