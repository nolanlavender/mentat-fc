import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiUrl } from '../api/client';
import type { Team } from '../api/types';
import { Crest } from './Crest';
import { navDisplayName } from '../lib/teamDisplay';

const COMPETITIONS = ['Premier League', 'Championship'] as const;

// Click-to-toggle, not hover-only: hover-only mega-menus don't work on
// touch devices at all, and this needs to work from every page in the
// nav, not just a desktop-pointer context.
export function TeamsNavDropdown() {
  const [open, setOpen] = useState(false);
  const [teamsByCompetition, setTeamsByCompetition] = useState<Record<string, Team[]> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (teamsByCompetition || !open) return;
    Promise.all(
      COMPETITIONS.map((c) =>
        fetch(apiUrl(`/api/teams?competition=${encodeURIComponent(c)}`)).then((res) => res.json() as Promise<Team[]>),
      ),
    ).then((results) => {
      setTeamsByCompetition(Object.fromEntries(COMPETITIONS.map((c, i) => [c, results[i]])));
    });
  }, [open, teamsByCompetition]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEscape(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  return (
    <div className="teams-nav-dropdown" ref={containerRef}>
      <button type="button" className="teams-nav-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Teams
      </button>
      {open && (
        <div className="teams-nav-panel">
          {COMPETITIONS.map((competition) => (
            <div key={competition} className="teams-nav-column">
              <h3>{competition}</h3>
              <ul>
                {teamsByCompetition?.[competition]?.map((team) => (
                  <li key={team.id}>
                    <Link to={`/teams/${team.id}`} onClick={() => setOpen(false)}>
                      <Crest src={team.logoUrl} alt="" size={18} />
                      {navDisplayName(team)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
