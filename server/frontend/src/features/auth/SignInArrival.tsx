import { useLayoutEffect } from "react";

/** Things arriving from nowhere: quick to start, long and soft to settle. */
const ARRIVE = "cubic-bezier(0.25, 0.8, 0.25, 1)";
const ARRIVE_MS = 520;
const STAGGER_MS = 60;

/**
 * The sign-in moment. The dashboard is already mounted and usable; this only
 * dresses its arrival: the header, then the content, rise into place in reading
 * order. Nothing takes input and nothing pulses. Reduced motion: a short fade.
 */
export function SignInArrival({ onDone }: { onDone: () => void }) {
  useLayoutEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const running = Array.from(
      document.querySelectorAll<HTMLElement>("[data-signin-arrive]"),
      (region, index) =>
        region.animate(
          reduce
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                { opacity: 0, transform: "translateY(8px)" },
                { opacity: 1, transform: "none" },
              ],
          {
            duration: reduce ? 160 : ARRIVE_MS,
            delay: reduce ? 0 : index * STAGGER_MS,
            easing: ARRIVE,
            fill: "backwards",
          },
        ),
    );

    // A run that was cleaned up (unmount, StrictMode's rehearsal) cancels its
    // animations, which settles their promises; it must not report done.
    let active = true;
    void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
      if (active) onDone();
    });
    return () => {
      active = false;
      running.forEach((animation) => animation.cancel());
    };
  }, [onDone]);

  return null;
}
