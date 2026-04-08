import './globals.css';

export const metadata = {
  title: 'The Circle — NCAA D1 Softball',
  description: 'Live scores, rankings, and stats for NCAA Division I softball.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
