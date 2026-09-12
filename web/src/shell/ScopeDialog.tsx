import { useEffect, useState } from "react";

import { Button } from "../components/ui/Button";
import { Dialog } from "../components/ui/Dialog";
import { SearchField } from "../components/ui/Fields";
import { Status, StatusDescriptor } from "../components/ui/Status";
import { plural } from "../lib/format";
import type { Game } from "../model";

// The scope picker: choosing a game re-scopes the whole console.
export function ScopeDialog({ open, onClose, games, currentId, statusOf, onSelect }: {
  open: boolean;
  onClose: () => void;
  games: readonly Game[];
  currentId: string | null;
  statusOf: (game: Game) => StatusDescriptor;
  onSelect: (gameId: string) => void;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => { if (open) setQuery(""); }, [open]);
  const needle = query.trim().toLocaleLowerCase();
  const visible = games.filter((game) => needle === "" || game.displayName.toLocaleLowerCase().includes(needle) || game.code.toLocaleLowerCase().includes(needle) || game.id.includes(needle));

  return (
    <Dialog actions={<Button onClick={onClose} variant="text">Cancel</Button>} className="scope-dialog" onClose={onClose} open={open} title="Select a game">
      <SearchField autoComplete="off" className="scope-search" data-autofocus label="Search games" onChange={(event) => setQuery(event.target.value)} placeholder="Search games" value={query} />
      <div aria-label="Games" className="scope-list" role="listbox">
        {visible.map((game) => {
          const status = statusOf(game);
          return (
            <button aria-selected={game.id === currentId} className="scope-row" key={game.id} onClick={() => onSelect(game.id)} role="option" type="button">
              <span aria-hidden="true" className="scope-code">{game.code}</span>
              <span>
                <strong>{game.displayName}</strong>
                <small>{plural(game.worlds.length, "world")} · {plural(game.presets.length, "preset")}</small>
              </span>
              <Status kind={status.kind} label={status.label} />
            </button>
          );
        })}
        {visible.length === 0 && <p className="scope-empty">No game matches “{query.trim()}”.</p>}
      </div>
    </Dialog>
  );
}
