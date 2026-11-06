import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The overview, clamped to four lines. The "More" toggle only appears when the
 * text actually overflows the clamp, so short synopses stay unadorned.
 */
export function Synopsis({ text }: { text: string }) {
  const id = useId();
  const ref = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || expanded) {
      return;
    }
    const measure = () => {
      setOverflowing(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <div className="flex max-w-[62ch] flex-col items-start gap-1">
      <p
        id={id}
        ref={ref}
        className={cn(
          "text-sm leading-relaxed text-pretty text-muted-foreground",
          !expanded && "line-clamp-4",
        )}
      >
        {text}
      </p>
      {overflowing || expanded ? (
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0 text-sm text-muted-foreground"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Less" : "More"}
        </Button>
      ) : null}
    </div>
  );
}
