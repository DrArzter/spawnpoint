import type { ScopeModel } from "../../core/models";
import { Icon } from "../../icons";
import { Dialog } from "./ui/Dialog";
import { GameGlyph } from "./ui/GameGlyph";
import { Status } from "./ui/Status";

/*
 * S1 stand-in for the scope switcher and its dialog (spec §3.6). S3 replaces
 * both with the segmented group and the full dialog.
 */

export function ScopeSwitcher({ model }: Readonly<{ model: ScopeModel }>) {
  if (!model.game) return null;
  return (
    <button aria-haspopup="dialog" className="c-scope-pick" data-action={model.show.id} data-tip={model.show.hint} onClick={model.show.run} type="button">
      <GameGlyph game={model.game} size="sm" />
      <span className="c-scope-name">{model.game.displayName}</span>
      <Icon name="expand_more" size={18} />
    </button>
  );
}

export function ScopeDialog({ model }: Readonly<{ model: ScopeModel }>) {
  if (!model.open) return null;
  return (
    <Dialog cancel={model.close} title="Game">
      <div className="c-stub-list" role="list">
        {model.games.map((game) => (
          <button aria-current={game.id === model.game?.id || undefined} className="c-stub-row" key={game.id} onClick={() => model.select(game.id)} role="listitem" type="button">
            <GameGlyph game={game} size="sm" />
            <span>{game.displayName}</span>
            <Status status={model.statusOf(game)} />
          </button>
        ))}
      </div>
    </Dialog>
  );
}
