import { repositoryName, shortCommit } from "../../../lib/format";

/**
 * Where a preset's files come from: the repository and the commit, short, in
 * mono, with the full reference in the title. Without a repository it is the
 * commit alone ("@abc1234"). With `href` it is a link, cut with an ellipsis
 * when its cell is narrow.
 */
export function SourceRef({ repository = null, commit, href }: Readonly<{ repository?: string | null; commit: string | null; href?: string }>) {
  const name = repository ? repositoryName(repository) : "";
  const text = commit ? `${name}@${shortCommit(commit)}` : name;
  const title = [repository, commit].filter(Boolean).join("@");
  return href
    ? <a className="c-mono c-source" href={href} rel="noreferrer" target="_blank" title={title}>{text}</a>
    : <span className="c-mono c-faint c-source" title={title}>{text}</span>;
}
