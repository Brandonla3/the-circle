import './globals.css';

export const metadata = {
  title: 'The Circle — NCAA D1 Softball',
  description: 'Live scores, rankings, and stats for NCAA Division I softball.',
  // ncaa.com refuses image requests whose Referer is anything other than
  // ncaa.com itself, which kills our team-logo loads. Strip Referer from
  // all outbound requests so the browser-issued img fetches reach the
  // NCAA CDN as direct (no-Referer) access. Same-origin /api/* calls and
  // navigation aren't affected.
  referrer: 'no-referrer',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
