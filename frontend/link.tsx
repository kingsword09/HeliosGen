import { forwardRef, type AnchorHTMLAttributes } from "react";
import { useRouter } from "./navigation";

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; replace?: boolean; scroll?: boolean; prefetch?: boolean };

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ href, replace, scroll, prefetch, onClick, children, ...props }, ref) {
  const router = useRouter();
  void prefetch;
  return <a {...props} ref={ref} href={href} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target || props.download) return;
    if (new URL(href, window.location.href).origin !== window.location.origin) return;
    event.preventDefault();
    router[replace ? "replace" : "push"](href, { scroll });
  }}>{children}</a>;
});

export default Link;
