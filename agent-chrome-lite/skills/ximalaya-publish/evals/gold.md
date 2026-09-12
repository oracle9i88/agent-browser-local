# 金样：跨域发布按钮定位与权限门禁

输入：`test/ximalaya-publish.test.mjs` 构造的喜马拉雅上传外壳、独立 iframe 会话、唯一 AX 按钮和几何坐标；`test/daemon-policy.test.mjs` 中的本地 finalize 权限场景。

从本项目根目录运行：

```bash
node --test test/ximalaya-publish.test.mjs test/daemon-policy.test.mjs
```

参考输出：所有测试通过、0 fail。特别检查 `locate uses the iframe AX node` 与 `Ximalaya iframe publish needs local finalize`。若匹配到零个或多个按钮、按钮禁用、iframe 离开白名单、坐标不可见或无本地 finalize 权限，不派发最终点击；只有已授权、唯一可见按钮才审计并派发一次。此金样不触碰真实喜马拉雅账号。

真实 Chromium 的本机金样（也不触碰平台账号）：

```bash
npm run test:frame-gold
```

参考输出包含 `"crossOriginFrame":true` 与 `"fixedFooterClickReachedButton":true`。
