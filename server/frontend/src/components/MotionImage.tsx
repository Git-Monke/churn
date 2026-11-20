import { useCallback, useRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Reveal newly loaded artwork in its reserved space. Cached images render immediately. */
export function MotionImage({ className, onLoad, ...props }: ComponentProps<"img">) {
  const pending = useRef(false);
  const trackLoad = useCallback((image: HTMLImageElement | null) => {
    pending.current = image !== null && !image.complete;
  }, []);
  return (
    <img
      key={props.src}
      {...props}
      className={cn("motion-image", className)}
      ref={trackLoad}
      onLoad={(event) => {
        if (pending.current) event.currentTarget.dataset.reveal = "";
        pending.current = false;
        onLoad?.(event);
      }}
    />
  );
}
