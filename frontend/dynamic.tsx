import { lazy, Suspense, type ComponentType } from "react";

export default function dynamic<Properties extends object>(loader: () => Promise<{ default: ComponentType<Properties> }>, options?: { ssr?: boolean; loading?: ComponentType }) {
  const Component = lazy(loader);
  const Loading = options?.loading;
  return function DynamicComponent(props: Properties) {
    return <Suspense fallback={Loading ? <Loading /> : null}><Component {...props} /></Suspense>;
  };
}
