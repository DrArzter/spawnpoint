import type { ScopeModel } from "../../core/models";
import { Icon } from "../../icons";
import { Dialog } from "./ui/Dialog";
import { GameGlyph } from "./ui/GameGlyph";
import { Status, StatusIcon } from "./ui/Status";

// Up to this many games stand in the top bar; more and the bar shows the current one and "More".
const SHOWN = 4;

/**
 * The game switcher in the top bar (spec §3.6). Both forms are in the
 * markup at every width and CSS shows one: a pill group from 1024px, one
 * pill that opens the dialog under it.
 */
export function ScopeSwitcher({ model }: Readonly<{ model: ScopeModel }>) {
  const current = model.game;
  if (!current) return null;
  const games = model.games.length > SHOWN ? [current] : model.games;
  return (
    <>
      <div aria-label="Game" className="c-scope" role="group">
        {games.map((game) => {
          const status = model.statusOf(game);
          return (
            <button
              aria-current={game.id === current.id || undefined}
              aria-label={`${game.displayName}, ${status.label}`}
              className="c-scope-game"
              key={game.id}
              onClick={() => model.select(game.id)}
              type="button"
            >
              <GameGlyph game={game} size="sm" />
              <span className="c-scope-name">{game.displayName}</span>
              <span className="c-scope-state">
                <StatusIcon kind={status.kind} size={15} />
                <span className="c-scope-state-label">{status.label}</span>
              </span>
            </button>
          );
        })}
        {games.length < model.games.length && (
          <button aria-haspopup="dialog" className="c-scope-game c-scope-more" data-action={model.show.id} onClick={model.show.run} type="button">
            <span>More</span>
            <Icon name="expand_more" size={18} />
          </button>
        )}
      </div>
      <button aria-haspopup="dialog" aria-label={`Game: ${current.displayName}`} className="c-scope-pick" data-action={model.show.id} data-tip={model.show.hint} onClick={model.show.run} type="button">
        <GameGlyph game={current} size="sm" />
        <span className="c-scope-name">{current.displayName}</span>
        <Icon name="expand_more" size={18} />
      </button>
    </>
  );
}

/** Every game, its state at the end edge; a choice selects the game and closes. */
export function ScopeDialog({ model }: Readonly<{ model: ScopeModel }>) {
  if (!model.open) return null;
  return (
    <Dialog cancel={model.close} title="Game">
      <div aria-label="Game" className="c-scope-list" role="radiogroup">
        {model.games.map((game) => {
          const checked = game.id === model.game?.id;
          return (
            <button aria-checked={checked} className="c-scope-row" key={game.id} onClick={() => model.select(game.id)} role="radio" type="button">
              <Icon className="c-scope-ring" name={checked ? "check_circle" : "radio_button_unchecked"} size={20} />
              <GameGlyph game={game} size="sm" />
              <span className="c-scope-row-name">{game.displayName}</span>
              <Status status={model.statusOf(game)} />
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
