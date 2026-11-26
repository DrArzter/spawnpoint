/**
 * Where a preset's files come from: the repository and the commit, short, in
 * mono, with the full reference in the title. `link` opens the repository.
 */
export function SourceRef({ repository, commit, link = false }: Readonly<{ repository: string; commit: string | null; link?: boolean }>) {
  const name = repository.replace(/^https?:\/\/(www\.)?github\.com\//, "");
  const text = commit ? `${name}@${commit.slice(0, 7)}` : name;
  const title = commit ? `${repository}@${commit}` : repository;
  return link
    ? <a className="c-mono c-source" href={repository} rel="noreferrer" target="_blank" title={title}>{text}</a>
    : <span className="c-mono c-faint c-source" title={title}>{text}</span>;
}
