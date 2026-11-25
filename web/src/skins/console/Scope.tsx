import type { KeyboardEvent } from "react";

import type { ScopeModel } from "../../core/models";
import { Icon } from "../../icons";
import { Dialog } from "./ui/Dialog";
import { GameGlyph } from "./ui/GameGlyph";
import { Status, StatusIcon } from "./ui/Status";
import { t } from "../../i18n";

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
      <div aria-label={t("common.game")} className="c-scope" role="group" /* NOSONAR a labelled set of game buttons; <fieldset> adds a frame and a legend */>
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
            <span>{t("world.more")}</span>
            <Icon name="expand_more" size={18} />
          </button>
        )}
      </div>
      <button aria-haspopup="dialog" aria-label={t("world.gameCurrentDisplayName", { currentDisplayName: current.displayName })} className="c-scope-pick" data-action={model.show.id} data-tip={model.show.hint} onClick={model.show.run} type="button">
        <GameGlyph game={current} size="sm" />
        <span className="c-scope-name">{current.displayName}</span>
        <Icon name="expand_more" size={18} />
      </button>
    </>
  );
}

const STEPS: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

// Arrow keys move between the games of the radio group; Enter or Space chooses one.
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const step = STEPS[event.key] ?? 0;
  if (step === 0) return;
  event.preventDefault();
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=radio]")];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  rows[(at + step + rows.length) % rows.length]?.focus();
}

/** Every game, its state at the end edge; a choice selects the game and closes. */
export function ScopeDialog({ model }: Readonly<{ model: ScopeModel }>) {
  if (!model.open) return null;
  return (
    <Dialog cancel={model.close} title={t("common.game")}>
      <div aria-label={t("common.game")} className="c-scope-list" onKeyDown={moveFocus} role="radiogroup" /* NOSONAR roving tabindex: the chosen row carries the tab stop */>
        {model.games.map((game) => {
          const checked = game.id === model.game?.id;
          return (
            <button aria-checked={checked} className="c-scope-row" key={game.id} onClick={() => model.select(game.id)} role="radio" tabIndex={checked || !model.game ? 0 : -1} type="button">
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
