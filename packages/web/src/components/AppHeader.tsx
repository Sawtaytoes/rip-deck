import { Nav, type NavItem } from "@charcuterie/ui"
import type { ReactNode } from "react"
import { useLocation } from "react-router"

import { SchemeSwitcher } from "./SchemeSwitcher"

const navigationItems: readonly NavItem[] = [
  { href: "/", label: "Deck" },
  { href: "/history", label: "History" },
]

/**
 * The shared page header. Navigation belongs to the app, not to one
 * page, so Deck and History stay available wherever the owner is.
 *
 * The product is Rip Deck. The hyphen belongs to its identifier,
 * such as the repository and image name, not to display text.
 */
export function AppHeader({
  children,
  subtitle,
  title,
  updatedAt,
}: {
  children?: ReactNode
  subtitle: ReactNode
  title: ReactNode
  /** `dataUpdatedAt`; omitted for pages that do not poll. */
  updatedAt?: number
}) {
  const { pathname } = useLocation()

  return (
    <header className="mb-4">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
        <h1 className="min-w-0 text-lg font-semibold">
          {title}
          {updatedAt !== undefined && updatedAt > 0 && (
            <small className="font-normal text-content-muted">
              · {new Date(updatedAt).toLocaleTimeString()}
            </small>
          )}
        </h1>

        <Nav
          activeHref={pathname}
          items={navigationItems}
          layout="bar"
          menuAlign="end"
        />

        <SchemeSwitcher />
      </div>

      <p className="mt-2 text-base text-content-muted">
        {subtitle}
      </p>

      {children !== undefined && (
        <div className="mt-3 flex flex-wrap items-start gap-x-4 gap-y-2">
          {children}
        </div>
      )}
    </header>
  )
}
