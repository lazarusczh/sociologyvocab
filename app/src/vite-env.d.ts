// 由 vite.config.ts 的 define 在构建/开发时注入：本份 JS 的构建版本号。
// 与服务器 /version.json 的 version 同源同值（都取自 vite.config.ts 的 BUILD_VERSION）。
declare const __APP_VERSION__: string;
