/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@ros/core", "@ros/db", "@ros/workers"],
  typescript: { ignoreBuildErrors: false },
  // Workspace packages use NodeNext-style "./x.js" specifiers that point at .ts sources.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    return config;
  },
};
export default nextConfig;
