/** @type {import('next').NextConfig} */
const config = {
  poweredByHeader: false,
  async redirects() {
    return [
      { source: "/index.html", destination: "/", permanent: false },
      { source: "/camera.html", destination: "/camera", permanent: false },
    ];
  },
};

export default config;
