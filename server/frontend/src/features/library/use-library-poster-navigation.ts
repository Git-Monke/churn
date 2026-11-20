import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import { flushSync } from "react-dom";

import { parseHash, useHashRoute, type AppRoute } from "@/hooks/use-hash-route";

type TitleRoute = Extract<AppRoute, { page: "movie" | "show" }>;

interface Selection {
  route: TitleRoute;
  link: HTMLAnchorElement;
  poster: HTMLElement | null;
  imageUrl?: string;
  pointer: boolean;
  scrollX: number;
  scrollY: number;
}

function matches(route: AppRoute, title: TitleRoute) {
  return route.page === title.page && route.source === title.source && route.id === title.id;
}

export function useLibraryPosterNavigation() {
  const selection = useRef<Selection | null>(null);
  const transition = useRef<{ view: ViewTransition; cleanUp: () => void } | null>(null);
  const main = useRef<HTMLElement>(null);
  const navigation = useRef(0);

  useEffect(() => () => {
    transition.current?.view.skipTransition();
    transition.current?.cleanUp();
  }, []);

  const onNavigate = useCallback((previous: AppRoute, next: AppRoute, commit: () => void) => {
    const version = ++navigation.current;
    transition.current?.view.skipTransition();
    transition.current?.cleanUp();
    const selected = selection.current;
    const opening = selected && previous.page === "library" && matches(next, selected.route);
    const fromTitle = selected && matches(previous, selected.route);
    const returning = selected && next.page === "library" && (fromTitle || previous.page === "play");
    const continuingPlayback = next.page === "play" && (fromTitle || previous.page === "play");

    if (!selected || (!opening && !returning)) {
      if (!selected || (!matches(next, selected.route) && !continuingPlayback)) selection.current = null;
      commit();
      return;
    }

    const hash = window.location.hash;
    const update = () => {
      if (version !== navigation.current || window.location.hash !== hash) return;
      flushSync(commit);
      if (returning) {
        window.scrollTo({ left: selected.scrollX, top: selected.scrollY, behavior: "instant" });
        const target = selected.link.isConnected ? selected.link : main.current;
        target?.focus({ preventScroll: true });
      } else {
        window.scrollTo({ left: 0, top: 0, behavior: "instant" });
        main.current?.focus({ preventScroll: true });
      }
    };

    if (!selected.pointer || previous.page === "play" || !selected.poster?.isConnected || !document.startViewTransition ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      update();
      return;
    }

    const root = document.documentElement;
    root.dataset.libraryPosterTransition = "";
    selected.poster.style.viewTransitionName = "library-poster";
    const active = document.startViewTransition(update);
    const cleanUp = () => {
      if (transition.current?.view !== active) return;
      transition.current = null;
      delete root.dataset.libraryPosterTransition;
      selected.poster?.style.removeProperty("view-transition-name");
    };
    transition.current = { view: active, cleanUp };
    void active.finished.then(cleanUp, cleanUp);
  }, []);

  const route = useHashRoute(onNavigate);
  const selected = selection.current;
  const poster = selected && matches(route, selected.route) ? selected : null;

  function onLibraryClick(event: MouseEvent) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
        event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>("a[data-library-title]");
    if (!link) return;
    const title = parseHash(link.hash);
    if (title.page !== "show" && title.page !== "movie") return;
    const image = link.querySelector("img");
    selection.current = {
      route: title,
      link,
      poster: image?.complete && image.naturalWidth > 0 ? image : null,
      imageUrl: image?.currentSrc || undefined,
      pointer: event.detail > 0,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
  }

  return { route, poster, keepLibrary: route.page === "library" || !!poster || (!!selected && route.page === "play"), main, onLibraryClick };
}
