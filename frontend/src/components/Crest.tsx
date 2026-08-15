import { useState } from 'react';

// Renders nothing (not a broken-image icon) when there's no URL, or the
// image fails to load -- team/player photo coverage from API-Football is
// real but not universal, especially outside the Premier League, and a
// broken-image glyph reads as an error rather than "no photo on file."
export function Crest({ src, alt, size = 24 }: { src: string | null; alt: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      className="crest"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function PlayerPhoto({ src, alt, size = 32 }: { src: string | null; alt: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      className="player-photo"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
