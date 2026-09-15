import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置 —— 决定「网页」怎么变成「安卓 App」。
 *
 * 三个关键点：
 *   appId    安卓包名，装了之后在系统里就是这个名字，发布后不能再改
 *   webDir   构建产物的目录（vite 输出到 dist/）
 *   android.zoomEnabled = false
 *            白板靠手指/笔在画布上画。WebView 自带的双指缩放会跟
 *            「两指拖动画布」抢手势，必须关掉，否则画着画着整个界面被放大。
 */
const config: CapacitorConfig = {
  appId: 'com.arcaneorion.whiteboard',
  appName: '共写白板',
  webDir: 'dist',
  android: {
    zoomEnabled: false,
  },
};

export default config;