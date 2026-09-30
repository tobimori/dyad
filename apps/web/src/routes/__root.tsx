import { RegistryProvider } from "@effect/atom-react";
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";

import stylesheet from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Dyad" },
      { name: "theme-color", content: "#151916" },
      { name: "description", content: "A local-first music library" },
    ],
    links: [
      { rel: "stylesheet", href: stylesheet },
      ...(import.meta.env.DEV ? [{ rel: "stylesheet", href: "/virtual:stylex.css" }] : []),
    ],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <main>
      <h1>Page not found</h1>
      <Link to="/">Return to Dyad</Link>
    </main>
  ),
});

function RootComponent() {
  return (
    <RegistryProvider>
      <Outlet />
    </RegistryProvider>
  );
}

function RootDocument({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
        {import.meta.env.DEV && <script type="module" src="/@id/virtual:stylex:runtime" />}
      </body>
    </html>
  );
}
