import { themeOf } from "../lib/themes.js";
import { Button, Chip, ProgressBar } from "./ui.jsx";
import UploadTile from "./UploadTile.jsx";

function headline(test, streakDays, hasDecks) {
  if (test) {
    if (test.days === 0) return `${test.title} is today.`;
    if (test.days === 1) return `${test.title} tomorrow.`;
    return `${test.title} in ${test.days} days.`;
  }
  if (!hasDecks) return "Lectures in, flashcards out.";
  if (streakDays > 1) return "Keep the streak going.";
  return "Ready when you are.";
}

function subline(shaky, readyCount, hasDecks) {
  if (!hasDecks) return "Upload a lecture PDF and get a summary plus a quiz deck you can study right away.";
  if (!readyCount) return "Your first deck is cooking. It usually takes under a minute.";
  if (!shaky) return "Every card you have is learned. Upload the next lecture when it's posted.";
  return `You've got ${shaky} ${shaky === 1 ? "card" : "cards"} still shaky. A short session now keeps you on track.`;
}

// upNext = { deck, stats, shaky: [indices], session } or null
export default function Hero({ test, streakDays, plannedToday, upNext, totalShaky, readyCount, hasDecks, onStart, onUpload, uploading }) {
  const theme = upNext && themeOf(upNext.deck);

  return (
    <section className="flex flex-wrap items-stretch gap-6">
      <div className="flex flex-[1_1_26rem] flex-col justify-center gap-4">
        <h1 className="max-w-xl text-h1 font-extrabold tracking-tighter sm:text-display">
          {headline(test, streakDays, hasDecks)}
        </h1>
        <p className="max-w-md text-lg text-ink-2">{subline(totalShaky, readyCount, hasDecks)}</p>
        {hasDecks && (
          <div className="flex flex-wrap gap-2">
            <Chip>{streakDays ? `${streakDays} day streak` : "No streak yet"}</Chip>
            {plannedToday > 0 && <Chip>{plannedToday} min planned today</Chip>}
          </div>
        )}
      </div>

      <div className="flex flex-[1_1_32rem] flex-col">
        {upNext ? (
          <article className={`flex min-h-75 flex-1 flex-col justify-between gap-8 rounded-card p-6 sm:p-8 ${theme.bg} ${theme.text}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-bold tracking-wider uppercase">
                {upNext.session ? "Planned for today" : "Up next"}
              </span>
              {test && <Chip className="bg-ink text-white">{test.days === 0 ? "Test today" : `Test in ${test.days}d`}</Chip>}
            </div>
            <div className="flex flex-col gap-2">
              <h2 className="text-h2 font-extrabold tracking-tight break-words sm:text-h1">{upNext.deck.name}</h2>
              <p>
                {upNext.stats.total} cards, {upNext.stats.learned} learned
              </p>
              <ProgressBar
                value={upNext.stats.learned}
                max={upNext.stats.total}
                label="Cards learned"
                track={theme.soft}
                bar={theme.bar}
                className="mt-2"
              />
            </div>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" onClick={() => onStart(upNext.deck)} className={theme.text === "text-white" ? "bg-white text-ink hover:bg-white/85" : ""}>
                Start session
              </Button>
              {upNext.shaky.length > 0 && upNext.shaky.length < upNext.stats.total && (
                <Button size="lg" variant="outline" onClick={() => onStart(upNext.deck, upNext.shaky)}>
                  Shaky cards only ({upNext.shaky.length})
                </Button>
              )}
            </div>
          </article>
        ) : (
          <UploadTile onUpload={onUpload} uploading={uploading} large />
        )}
      </div>
    </section>
  );
}
