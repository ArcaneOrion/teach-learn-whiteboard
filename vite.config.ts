import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // host: true 让开发服务器监听局域网地址。
    // 这样你可以用手机浏览器打开电脑的地址，直接在真机上试手感 ——
    // 在装上 Capacitor 之前，这是最快拿到"真机触摸体验"的办法。
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    // Capacitor 之后会把 dist/ 打进 App，关掉不必要的 sourcemap 体积
    sourcemap: false,
  },
});
