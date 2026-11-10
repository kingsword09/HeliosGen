import { useMemo, useSyncExternalStore } from "react";

const subscribe = (notify: () => void) => {
  window.addEventListener("popstate", notify);
  return () => window.removeEventListener("popstate", notify);
};
const locationSnapshot = () => window.location.pathname + window.location.search;

function navigate(href: string, replace: boolean, options?: { scroll?: boolean }) {
  const target = new URL(href, window.location.href);
  if (target.origin !== window.location.origin) {
    window.location.assign(target.href);
    return;
  }
  window.history[replace ? "replaceState" : "pushState"]({}, "", target);
  window.dispatchEvent(new PopStateEvent("popstate"));
  if (options?.scroll !== false) window.scrollTo(0, 0);
}

export function usePathname() {
  return useSyncExternalStore(subscribe, locationSnapshot).split("?")[0];
}

export function useSearchParams() {
  const current = useSyncExternalStore(subscribe, locationSnapshot);
  return useMemo(() => new URLSearchParams(current.includes("?") ? current.slice(current.indexOf("?") + 1) : ""), [current]);
}

export function useRouter() {
  return useMemo(() => ({
    push: (href: string, options?: { scroll?: boolean }) => navigate(href, false, options),
    replace: (href: string, options?: { scroll?: boolean }) => navigate(href, true, options),
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh: () => window.dispatchEvent(new PopStateEvent("popstate")),
    prefetch: () => Promise.resolve(),
  }), []);
}

export function redirect(href: string) {
  navigate(href, true);
}
