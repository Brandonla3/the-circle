/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      // LSU (WMT Digital) — hand-curated static roster uses these CDN URLs.
      { protocol: 'https', hostname: 'lsusports.net' },
      { protocol: 'https', hostname: 'storage.googleapis.com' },
    ],
  },
};
