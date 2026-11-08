import { deckStats } from "../lib/progress.js";
import { themeOf } from "../lib/themes.js";
import { AlertIcon, SpinnerIcon, TrashIcon } from "./Icons.jsx";
import { Button, Chip, IconButton, ProgressBar } from "./ui.jsx";

const TILE = "flex min-h-56 flex-col justify-between gap-6 rounded-card p-6";

function Title({ children }) {
  return <h3 className="line-clamp-2 text-title font-semibold break-words">{children}</h3>;
}

export default function DeckTile({ deck, progress, onStudy, onRemove }) {
  const remove = (
    <IconButton label={`Remove ${deck.name}`} onClick={() => onRemove(deck.id)} className="-mt-2 -mr-2">
      <TrashIcon width={16} height={16} />
    </IconButton>
  );

  if (deck.status === "queued" || deck.status === "processing") {
    return (
      <article className={`${TILE} bg-sunken`}>
        <Chip className="self-start bg-white">
          <SpinnerIcon width={12} height={12} />
          {deck.status === "queued" ? "In line" : "Making cards"}
        </Chip>
        <div className="flex flex-col gap-3">
          <Title>{deck.name}</Title>
          <div className="h-2 overflow-hidden rounded-full bg-line" aria-hidden="true">
            <div className="animate-slide h-full w-2/5 rounded-full bg-ink" />
          </div>
          <p className="text-xs text-ink-2">Usually under a minute</p>
        </div>
      </article>
    );
  }

  const empty = deck.status === "done" && !deck.cards.length;
  if (deck.status === "failed" || empty) {
    return (
      <article className={`${TILE} border border-line bg-white`}>
        <div className="flex items-start justify-between gap-2">
          <Chip className="bg-danger-soft text-danger">
            <AlertIcon width={14} height={14} />
            Couldn't make cards
          </Chip>
          {remove}
        </div>
        <div className="flex flex-col gap-1">
          <Title>{deck.name}</Title>
          <p className="line-clamp-3 text-sm text-ink-2">
            {empty ? "No cards came out of this one. Is the PDF mostly images?" : deck.error || "Something went wrong."}
          </p>
        </div>
      </article>
    );
  }

  const theme = themeOf(deck);
  const stats = deckStats(deck, progress);
  return (
    <article className={`${TILE} ${theme.bg} ${theme.text}`}>
      <div className="flex items-start justify-between gap-2">
        <Chip className={theme.soft}>{stats.total} cards</Chip>
        {remove}
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Title>{deck.name}</Title>
          <p className="text-sm">
            {stats.learned === 0 && stats.missed === 0
              ? "Not started"
              : stats.learned === stats.total
                ? "All learned"
                : `${stats.learned} of ${stats.total} learned`}
          </p>
        </div>
        <ProgressBar value={stats.learned} max={stats.total} label="Cards learned" track={theme.soft} bar={theme.bar} />
        <Button variant="outline" size="sm" className="self-start" onClick={() => onStudy(deck)}>
          Study
        </Button>
      </div>
    </article>
  );
}
