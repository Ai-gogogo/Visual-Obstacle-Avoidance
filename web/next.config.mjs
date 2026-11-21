import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const config = {
  poweredByHeader: false,
  turbopack: { root: fileURLToPath(new URL("..", import.meta.url)) },
  async redirects() {
    return [
      { source: "/index.html", destination: "/", permanent: false },
      { source: "/camera.html", destination: "/camera", permanent: false },
    ];
  },
};

export default config;
