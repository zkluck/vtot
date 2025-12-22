/**
 * Next.js 配置（Renderer）。
 *
 * 说明：
 * - 这里先保持最小配置，确保能快速跑起来。
 * - 后续若要做 Electron 打包（静态导出 / 内置 server），再补充对应配置。
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true
};

module.exports = nextConfig;
