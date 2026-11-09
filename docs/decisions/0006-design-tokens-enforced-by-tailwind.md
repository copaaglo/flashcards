# 0006: Design tokens enforced by Tailwind

**Status:** Accepted (UI redesign, after week 8)

## Context

The first study planner UI was built fast and it showed: 19 font sizes, 7 border radii, 9 gap sizes and about 51 raw colors in one CSS file, plus gradient glows and glassy cards. None of it was wrong on its own, but nothing lined up, and every new screen added more one-off values. That is what makes an app look "vibe coded".

## Decision

The web app is styled with Tailwind CSS v4, and the theme in `apps/web/src/index.css` deletes Tailwind's default palette, type sizes, radii and shadows (`--color-*: initial` and so on) and defines only our tokens:

- Warm neutrals for the chrome (paper, sunken, line, ink) and five deck themes (tangerine, lilac, mint, lemon, cobalt). Every deck gets one theme, so color means "this deck", not decoration.
- Nine type sizes, two fonts (Bricolage Grotesque for headings, DM Sans for text), three radii (12, 16, 24 px), one shadow for overlays. Spacing is Tailwind's 4 px scale.
- Fonts are self-hosted from npm packages, so the app makes no third-party requests at runtime.

Buttons, chips and progress bars live in `components/ui.jsx`, so their variants are defined once. The design was mocked up and agreed on before any code was written.

## Consequences

- An off-system value like `bg-teal-400` or `text-5xl` doesn't compile to anything, so drift shows up immediately in review instead of piling up.
- Changing the look (say, a new accent) is an edit to one file of tokens.
- Long class lists in JSX are the price. Repeated patterns go into a component instead of a custom CSS class.
- One-off values (`text-[6rem]`) are still possible with brackets. Review should push back on them.
- Dark mode isn't designed yet. It would be a second set of the same token names under a media query.
