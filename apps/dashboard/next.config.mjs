/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  env: {
    QUOTA_SERVICE_URL: process.env.QUOTA_SERVICE_URL || "http://localhost:7001",
    POLICY_SERVICE_URL: process.env.POLICY_SERVICE_URL || "http://localhost:7002",
    LEARNING_SERVICE_URL: process.env.LEARNING_SERVICE_URL || "http://localhost:7003",
    BRIDGE_SERVICE_URL: process.env.BRIDGE_SERVICE_URL || "http://localhost:7100",
  },
};
export default nextConfig;
