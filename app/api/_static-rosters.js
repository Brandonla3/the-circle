// Hand-curated static rosters for schools whose sites aren't accessible
// via a server-side API (WMT Digital, etc.).
//
// Each entry shape matches what applyRosterPlayer() expects:
//   { number, name, position, photoUrl }
//
// Fields intentionally omitted (not available from the static scrape):
//   hometown, highSchool, previousSchool, heightDisplay, weight, batThrows, cls
// Those will still be filled in by the ESPN secondary pass when available.
//
// To update a roster: replace the players array. photoUrls come directly
// from the school's CDN — no proxying needed because the Next.js
// next.config.js image.remotePatterns allows lsusports.net and
// storage.googleapis.com.

// ── LSU (lsusports.net — WMT Digital, no server-side roster API) ────────────
const LSU_ROSTER = [
  { number: '00', name: 'Jayden Heavener',  position: 'P',  photoUrl: 'https://lsusports.net/imgproxy/pTwLUID0IEUI_iNTbS5bJ04QsO9YkSRTRWNbxeh2KsE/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS83NDcwNTlkZS1qYWR5bl9oZWF2ZW5lcl8yMDI1LmpwZw.png' },
  { number: '1',  name: 'Ally Hutchins',    position: 'IF', photoUrl: 'https://lsusports.net/imgproxy/SquBYsL2DimM85q8HbvsJR2IteuicnGjXFkwv6eyS20/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS9iNjY5YjIwMi1hbGx5X2h1dGNoaW5zXzIwMjUuanBn.png' },
  { number: '2',  name: 'Maddox McKee',     position: 'UT', photoUrl: 'https://lsusports.net/imgproxy/M1sk1ZkfWVWfJ6_liPQYSrXKxlUCpJW3V0BTTAypMNY/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS85ZWVhYzQyNC1tYWRkb3hfbWNrZWVfMjAyNS5qcGc.png' },
  { number: '4',  name: 'Gradie Appling',   position: 'UT', photoUrl: 'https://lsusports.net/imgproxy/otj93SHJZ6gci9T8CtyXKQSeA4g2QxxEdteTC3_Q0VE/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS81MmVkODU0Zi1ncmFkaWVfYXBwbGluZ18yMDI1LmpwZw.png' },
  { number: '7',  name: 'Jalia Lassiter',   position: 'OF', photoUrl: 'https://lsusports.net/imgproxy/9QmchvF-tF6XjP7i5djdOqyaq0yFKks80xjWvWEZqzY/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS81MmI2OTUyMC1qYWxpYV9sYXNzaXRlcl8yMDI1LmpwZw.png' },
  { number: '8',  name: 'Cali Deal',         position: 'P',  photoUrl: 'https://lsusports.net/imgproxy/_wlx8I6666M0ZeDX5wfZ1XSefsYKc7Fc0mr-fs19UVE/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS8xNWY4Zjg0OC1jYWxpX2RlYWxfMjAyNS5qcGc.png' },
  { number: '10', name: 'Rylie Johnson',     position: 'OF', photoUrl: 'https://lsusports.net/imgproxy/z_CFxmXXd5Vsq4OzyW9imjW8cpAKMSslOXzr-z8IQvk/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS81YjdmZGM3My1yeWxpZV9qb2huc29uXzIwMjUuanBn.png' },
  { number: '11', name: 'Lauryn Soeken',     position: 'P',  photoUrl: 'https://lsusports.net/imgproxy/QuTvXiwmZDXVNSr3II_-Jbp_xBjEorptEHwei8pzg2o/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS81Yzk1OGRjMi1sYXVyeW5fc29la2VuXzIwMjUuanBn.png' },
  { number: '12', name: 'Maci Bergeron',     position: 'C',  photoUrl: 'https://lsusports.net/imgproxy/ErXdTItbOB1XqYp0QVieXbTJuHGd6W3SeWKPxCjlOfM/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS9lNjg4YjA2My1tYWNpX2Jlcmdlcm9uXzIwMjUuanBn.png' },
  { number: '14', name: 'Ashlin Mowery',     position: 'UT', photoUrl: 'https://lsusports.net/imgproxy/du9sRM1icUl-V4T_8_t6udE1p126SSxM4OAiECDD3ck/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS84OWVhMGYwYy1hc2hsaW5fbW93ZXJ5XzIwMjUuanBn.png' },
  { number: '15', name: 'Jadyn Laneaux',     position: 'OF', photoUrl: 'https://lsusports.net/imgproxy/pxe23lI_hW02Kao0hBmU_zYpWgeSPJGK2I2ruKX_GM8/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS80YmY0YmFhOC1qYWR5bl9sYW5lYXV4XzIwMjUuanBn.png' },
  { number: '17', name: 'Paytn Monticelli',  position: 'P',  photoUrl: 'https://lsusports.net/imgproxy/-y_7j25tZyNYq7DbHQsnXl-3qGav1p_iVbGKytdJaQA/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8xMS8zNmZiOWZhNi1wYXl0bl9tb250aWNlbGxpXzIwMjUuanBn.png' },
  { number: '18', name: 'Tatum Clopton',     position: 'P',  photoUrl: 'https://lsusports.net/imgproxy/Fu6NEl8rdqqIKTf-K84vLhgTi7BiNC85y-KaVKxwuY4/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS9lZjY5MGZhMy10YXR1bV9jbG9wdG9uXzIwMjUuanBn.png' },
  { number: '20', name: 'Alix Franklin',     position: 'UT', photoUrl: 'https://lsusports.net/imgproxy/C_4er5e4R9YQDPffIqc4-bxSdFFPnXDPZgc57wwnYZk/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS9hMTYwNjZiZS1hbGl4X2ZyYW5rbGluXzIwMjUuanBn.png' },
  { number: '21', name: 'Cece Cellura',      position: 'P',  photoUrl: 'https://lsusports.net/imgproxy/_NtM8CnVRqA3N-zWgoG8Cog3vFhP_TM95meEf0HBFsI/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS83MjQ2MmQ0OC1jZWNlX2NlbGx1cmFfMjAyNS5qcGc.png' },
  { number: '23', name: 'Sierra Daniel',     position: 'UT', photoUrl: 'https://lsusports.net/imgproxy/CkcOZnsyDBLjNhpH--RfQPDcJ_l48WI0yL0BOIL1vek/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS9mMDFlYWUyNi1zaWVycmFfZGFuaWVsXzIwMjUuanBn.png' },
  { number: '24', name: 'Char Lorenz',       position: 'UT', photoUrl: 'https://lsusports.net/imgproxy/WjuysZaemzQ12ZGWdnYoTvGMTue_YX_qcUXQSwJx_yQ/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS9hODJhMjI3My1jaGFyX2xvcmVuel8yMDI1LmpwZw.png' },
  { number: '28', name: 'Jada Phillips',     position: 'C',  photoUrl: 'https://lsusports.net/imgproxy/HzAJCmBU7TE16F-iDWsMldERP699cuXogRyUMTz5RKA/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS8xZWZjNjNhZC1qYWRhX3BoaWxsaXBzXzIwMjUuanBn.png' },
  { number: '33', name: 'Destiny Harris',    position: 'OF', photoUrl: 'https://lsusports.net/imgproxy/5iwx_PBjqPoPRUn5tzhWL3UTqEqPYooo03m3TIU0HAQ/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS9iOTQ0NTRlNS1kZXN0aW55X2hhcnJpc18yMDI1LmpwZw.png' },
  { number: '42', name: 'Tori Edwards',      position: 'UT', photoUrl: 'https://lsusports.net/imgproxy/M6N7eZdyKks__RVikvudHaV8bfjf2BF_r4gVp0eD98Y/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS84MTNkMzVlZi10b3JpX2Vkd2FyZHNfMjAyNS5qcGc.png' },
  { number: '44', name: "Ci'ella Pickett",   position: 'UT', photoUrl: 'https://lsusports.net/imgproxy/SmqEv6m83W5jaJaPbDMNV3Bgb3tx39ibjSXyTfGvFcw/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS9hYzgxMmVmMC1jaWVsbGFfcGlja2V0dF8yMDI1LmpwZw.png' },
  { number: '67', name: 'Kylee Edwards',     position: 'IF', photoUrl: 'https://lsusports.net/imgproxy/oSDl0gnqmCt6nDyk-5e7BUeGG-Yq5lb4xESCnRioKDc/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS9kOTJjZDRkMy1reWxlZV9lZHdhcmRzXzIwMjUuanBn.png' },
  { number: '82', name: 'Avery Hodge',       position: 'IF', photoUrl: 'https://lsusports.net/imgproxy/pKpF8CoLmHBCEffQFoOpjLbH6vTv4Oel-LEAIcn2yGo/fit/600/800/ce/0/aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL2xzdXNwb3J0cy1jb20vMjAyNS8wOS9iMjM2MDc1OC1hdmVyeV9ob2RnZV8yMDI1LmpwZw.png' },
];

// ── Lookup map ───────────────────────────────────────────────────────────────
// Keys are lowercased ESPN displayName values (same normalization as _espn.js).
// Values are the roster array for that school.
// Add future hand-curated schools here with their ESPN display name as the key.
const STATIC_ROSTER_MAP = {
  'lsu': LSU_ROSTER,
};

function norm(s) {
  return (s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Return a static roster array for the given ESPN name variant set, or null.
// Each element: { number, name, position, photoUrl }
export function getStaticRoster(nameVariantSet) {
  for (const v of nameVariantSet) {
    const n = norm(v);
    if (STATIC_ROSTER_MAP[n]) return STATIC_ROSTER_MAP[n];
  }
  // Substring fallback for decorated names like "LSU Tigers" → "lsu".
  for (const v of nameVariantSet) {
    const n = norm(v);
    for (const [key, roster] of Object.entries(STATIC_ROSTER_MAP)) {
      if (n.includes(key) || key.includes(n)) return roster;
    }
  }
  return null;
}
