import { EllipsisIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface TitleMenuItem {
  label: string;
  onSelect: () => void;
  /** Destructive items read in the danger colour; the dialog still confirms. */
  destructive?: boolean;
}

/**
 * The "⋯" actions next to the primary button. Items are supplied by the page so
 * the menu follows the title's state without the component knowing about it.
 */
export function TitleMenu({ items }: { items: TitleMenuItem[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon-lg"
          className="size-12"
          aria-label="More actions"
        >
          <EllipsisIcon className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            variant={item.destructive ? "destructive" : "default"}
            className="min-h-10 px-2.5"
            onSelect={() => item.onSelect()}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
