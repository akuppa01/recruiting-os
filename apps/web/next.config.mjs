/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@ros/core", "@ros/db", "@ros/workers"],
  typescript: { ignoreBuildErrors: false },
};
export default nextConfig;
