import { useLayoutEffect, useRef, type MouseEvent } from "react";

/** Keep the indicator aligned even as labels or the viewport resize. */
export function useSelectionUnderline<T extends HTMLElement>(selected: string | number | null, scroll = false) {
  const track = useRef<T>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const animate = useRef(false);

  useLayoutEffect(() => {
    const container = track.current;
    const line = indicator.current;
    const item = container?.querySelector<HTMLElement>("[data-underline-active]");
    if (!container || !line || !item) {
      if (line) line.hidden = true;
      return;
    }

    const position = () => {
      const old = line.getBoundingClientRect();
      const canMove = animate.current && !line.hidden && old.width > 0
        && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      animate.current = false;
      line.getAnimations().forEach((animation) => animation.cancel());
      line.hidden = false;
      line.style.left = `${item.offsetLeft}px`;
      line.style.top = `${item.offsetTop + item.offsetHeight - 2}px`;
      line.style.width = `${item.offsetWidth}px`;
      const next = line.getBoundingClientRect();
      if (canMove && next.width > 0 && Math.abs(old.top - next.top) < 2) {
        line.animate(
          [{ transform: `translateX(${old.left - next.left}px) scaleX(${old.width / next.width})` },
            { transform: "translateX(0) scaleX(1)" }],
          { duration: 160, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
        );
      }
    };

    if (scroll) {
      const left = item.offsetLeft;
      const right = left + item.offsetWidth;
      if (left < container.scrollLeft) container.scrollLeft = left;
      else if (right > container.scrollLeft + container.clientWidth) {
        container.scrollLeft = right - container.clientWidth;
      }
    }
    position();
    const observer = new ResizeObserver(() => {
      if (line.offsetLeft !== item.offsetLeft || line.offsetWidth !== item.offsetWidth ||
          line.offsetTop !== item.offsetTop + item.offsetHeight - 2) position();
    });
    observer.observe(container);
    observer.observe(item);
    return () => observer.disconnect();
  }, [scroll, selected]);

  function onClick(event: MouseEvent, changesSelection: boolean) {
    animate.current = changesSelection && event.detail > 0 && !event.altKey &&
      !event.ctrlKey && !event.metaKey && !event.shiftKey;
  }

  return { track, indicator, onClick };
}
