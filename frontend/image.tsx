import { forwardRef, type ImgHTMLAttributes, type SyntheticEvent } from "react";

type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string | { src: string; width?: number; height?: number };
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  unoptimized?: boolean;
};

const Image = forwardRef<HTMLImageElement, ImageProps>(function Image({ src, fill, priority, quality, unoptimized, style, loading, width, height, ...props }, ref) {
  const original = typeof src === "string" ? src : src.src;
  const displayWidth = width ?? (typeof src === "string" ? undefined : src.width);
  const optimize = !unoptimized && !original.startsWith("data:") && !original.startsWith("blob:") && !/\.(svg|gif)(?:[?#]|$)/i.test(original);
  const thumbnail = (size: number) => `/api/thumbnail?url=${encodeURIComponent(original)}&w=${size}&q=${quality ?? 75}`;
  const imageWidth = Number(displayWidth) || 1024;
  const handleError = (event: SyntheticEvent<HTMLImageElement>) => {
    if (optimize && event.currentTarget.src !== new URL(original, window.location.href).href) {
      event.currentTarget.removeAttribute("srcset");
      event.currentTarget.src = original;
      return;
    }
    props.onError?.(event);
  };
  return <img {...props} alt={props.alt ?? ""} ref={ref} onError={handleError} src={optimize ? thumbnail(imageWidth) : original} srcSet={props.srcSet ?? (optimize && displayWidth ? `${thumbnail(imageWidth)} 1x, ${thumbnail(Math.min(4096, imageWidth * 2))} 2x` : undefined)} width={fill ? undefined : displayWidth} height={fill ? undefined : height ?? (typeof src === "string" ? undefined : src.height)} loading={priority ? "eager" : loading ?? "lazy"} fetchPriority={priority ? "high" : props.fetchPriority} decoding="async" style={{ ...(fill ? { position: "absolute", inset: 0, width: "100%", height: "100%" } as const : {}), ...style }} />;
});

export default Image;
