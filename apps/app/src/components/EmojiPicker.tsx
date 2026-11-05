import { EmojiPicker as Picker } from 'frimousse'
import { useEffect, useRef } from 'react'

/** Alle emoji med søk på norsk. Lastes først når noen åpner den. */
export default function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const search = useRef<HTMLInputElement>(null)
  // På mobil ville tastaturet dekke lista.
  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) search.current?.focus({ preventScroll: true })
  }, [])

  return (
    <Picker.Root
      locale="nb"
      emojibaseUrl="/emoji"
      columns={8}
      onEmojiSelect={({ emoji }) => onPick(emoji)}
      className="isolate flex h-full w-full flex-col"
    >
      <div className="flex items-center gap-1 p-2">
        <Picker.Search
          ref={search}
          placeholder="Søk etter emoji"
          aria-label="Søk etter emoji"
          className="h-9 min-w-0 flex-1 rounded-lg bg-stone-100 px-2.5 text-sm text-stone-900 outline-none placeholder:text-stone-500 focus:ring-2 focus:ring-brand-200"
        />
        <Picker.SkinToneSelector
          aria-label="Bytt hudfarge"
          title="Bytt hudfarge"
          className="grid size-9 shrink-0 place-items-center rounded-lg text-lg transition hover:bg-stone-100"
        />
      </div>
      <Picker.Viewport className="relative flex-1 outline-none">
        <Picker.Loading className="absolute inset-0 grid place-items-center text-sm text-stone-500">
          Laster …
        </Picker.Loading>
        <Picker.Empty className="absolute inset-0 grid place-items-center text-sm text-stone-500">
          Fant ingen emoji.
        </Picker.Empty>
        <Picker.List
          className="pb-2 select-none"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div
                {...props}
                className="bg-white px-3 pt-2 pb-1 text-xs font-medium text-stone-500 first-letter:uppercase"
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div {...props} className="px-2">
                {children}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button
                {...props}
                className="grid size-9 place-items-center rounded-lg text-lg data-active:bg-stone-100"
              >
                {emoji.emoji}
              </button>
            ),
          }}
        />
      </Picker.Viewport>
    </Picker.Root>
  )
}
