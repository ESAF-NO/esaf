import { Link, useLocation, useRouteContext, useRouter } from '@tanstack/react-router'
import {
  Building2,
  GraduationCap,
  House,
  KeyRound,
  LogOut,
  Menu,
  PenSquare,
  Search,
  ShieldCheck,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { authClient } from '#/lib/auth-client.ts'
import { channelOrder, channels } from '#/lib/channels.ts'
import { CommandPalette } from './CommandPalette.tsx'
import { NotificationBell } from './Notifications.tsx'
import { Avatar, buttonClass, cx, Logo } from './ui.tsx'

function NavItem({
  to,
  search,
  icon: Icon,
  label,
  active,
  dot,
  onNavigate,
}: {
  to: string
  search?: Record<string, string>
  icon?: LucideIcon
  label: string
  active: boolean
  dot?: string
  onNavigate?: () => void
}) {
  return (
    <Link
      to={to}
      search={search}
      onClick={onNavigate}
      className={cx(
        'group flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm font-medium transition',
        active
          ? 'bg-white text-stone-950 shadow-card ring-1 ring-stone-200'
          : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900',
      )}
    >
      {Icon && (
        <Icon
          className={cx(
            'size-[18px]',
            active ? 'text-brand-600' : 'text-stone-400 group-hover:text-stone-600',
          )}
          aria-hidden
        />
      )}
      {dot && (
        <span className="grid size-[18px] place-items-center" aria-hidden>
          <span className={cx('size-2 rounded-full', dot)} />
        </span>
      )}
      <span>{label}</span>
    </Link>
  )
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { viewer } = useRouteContext({ from: '__root__' })
  const location = useLocation()
  const router = useRouter()
  const kanal = new URLSearchParams(location.searchStr).get('kanal')
  const path = location.pathname
  const onFeed = path === '/feed'

  async function signOut() {
    await authClient.signOut()
    await router.invalidate()
    await router.navigate({ to: '/' })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center px-5">
        <Link to="/feed" onClick={onNavigate} aria-label="ESAF, til forsiden">
          <Logo />
        </Link>
      </div>

      <nav aria-label="Hovedmeny" className="flex-1 space-y-6 overflow-y-auto px-3 pb-6">
        <div className="space-y-0.5">
          <NavItem
            to="/feed"
            icon={House}
            label="Hjem"
            active={onFeed && !kanal}
            onNavigate={onNavigate}
          />
          <NavItem
            to="/medlemmer"
            icon={Users}
            label="Personer"
            active={path.startsWith('/medlemmer') && !path.includes(viewer.personId ?? '§')}
            onNavigate={onNavigate}
          />
          <NavItem
            to="/kull"
            icon={GraduationCap}
            label="Kull"
            active={path === '/kull'}
            onNavigate={onNavigate}
          />
          <NavItem
            to="/selskaper"
            icon={Building2}
            label="Selskaper"
            active={path.startsWith('/selskaper')}
            onNavigate={onNavigate}
          />
          {viewer.adminArea && (
            <NavItem
              to="/admin"
              icon={ShieldCheck}
              label="Admin"
              active={path === '/admin'}
              onNavigate={onNavigate}
            />
          )}
        </div>

        <div>
          <p className="px-2.5 pb-2 text-[11px] font-semibold tracking-wider text-stone-400 uppercase">
            Kanaler
          </p>
          <div className="space-y-0.5">
            {channelOrder.map((key) => (
              <NavItem
                key={key}
                to="/feed"
                search={{ kanal: key }}
                dot={channels[key].dot}
                label={channels[key].plural}
                active={onFeed && kanal === key}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      </nav>

      <div className="border-t border-stone-200 p-3">
        {viewer.personId && viewer.fullName && (
          <Link
            to="/medlemmer/$personId"
            params={{ personId: viewer.personId }}
            onClick={onNavigate}
            className="flex items-center gap-3 rounded-xl p-2 transition hover:bg-stone-100"
          >
            <Avatar name={viewer.fullName} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-stone-900">
                {viewer.fullName}
              </span>
              <span className="block truncate text-xs text-stone-500">
                {[viewer.jobTitle, viewer.currentCompany].filter(Boolean).join(' · ') ||
                  'Se profilen din'}
              </span>
            </span>
          </Link>
        )}
        <Link
          to="/konto"
          onClick={onNavigate}
          className="mt-1 flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-stone-500 transition hover:bg-stone-100 hover:text-stone-900"
        >
          <KeyRound className="size-4" aria-hidden /> Konto og sikkerhet
          {viewer.twoFactorMissing && (
            <span
              className="ml-auto size-2 rounded-full bg-amber-500"
              aria-label="Tofaktor mangler"
            />
          )}
        </Link>
        <button
          type="button"
          onClick={signOut}
          className="flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-stone-500 transition hover:bg-stone-100 hover:text-stone-900"
        >
          <LogOut className="size-4" aria-hidden /> Logg ut
        </button>
      </div>
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing =
        e.target instanceof HTMLElement &&
        e.target.closest('input, textarea, select, [contenteditable]')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((open) => !open)
      } else if (e.key === '/' && !typing) {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="min-h-dvh">
      <a
        href="#innhold"
        className="sr-only z-50 rounded-lg bg-stone-900 px-3 py-2 text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Hopp til innhold
      </a>

      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-stone-200/80 bg-stone-50 lg:block">
        <Sidebar />
      </aside>

      {menuOpen && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Meny"
        >
          <button
            type="button"
            className="absolute inset-0 bg-stone-950/30 backdrop-blur-[2px]"
            aria-label="Lukk menyen"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-72 animate-in bg-stone-50 shadow-xl">
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              className="absolute top-4 right-3 grid size-8 place-items-center rounded-lg text-stone-500 hover:bg-stone-100"
              aria-label="Lukk menyen"
            >
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setMenuOpen(false)} />
          </div>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-stone-200/80 bg-stone-50/85 px-4 backdrop-blur-md sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="grid size-9 place-items-center rounded-lg text-stone-600 hover:bg-stone-100 lg:hidden"
            aria-label="Åpne menyen"
          >
            <Menu className="size-5" />
          </button>

          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-xl bg-white px-3 text-sm text-stone-400 shadow-card ring-1 ring-stone-200 transition hover:ring-stone-300 sm:max-w-md"
          >
            <Search className="size-4 shrink-0" aria-hidden />
            <span className="flex-1 truncate text-left">
              Søk<span className="hidden sm:inline"> etter personer, selskaper og innlegg</span>
            </span>
            <kbd className="hidden rounded-md bg-stone-100 px-1.5 py-0.5 font-sans text-[11px] font-medium text-stone-500 sm:block">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <NotificationBell />
            <Link
              to="/feed/ny"
              className={buttonClass({ variant: 'brand' }, 'px-3 sm:px-4')}
              aria-label="Nytt innlegg"
            >
              <PenSquare className="size-4" aria-hidden />
              <span className="hidden sm:inline">Nytt innlegg</span>
            </Link>
          </div>
        </header>

        <main id="innhold" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
          {children}
        </main>
      </div>

      {searchOpen && <CommandPalette onClose={() => setSearchOpen(false)} />}
    </div>
  )
}
