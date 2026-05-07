# @noma/ui 编辑指南

本文件约束 `packages/ui` 内的后续修改。

## 必守边界

- 只放纯展示组件，不写业务逻辑、路由跳转、数据请求或状态管理。
- 不依赖 `react-router-dom`、Electron API、`@noma/shared` 或任何业务包。唯一的 peer 依赖是 `react`。
- 组件命名参照 Ant Design 体系：`Button`、`Tag`、`Badge`、`Switch`、`Segmented`、`Avatar`、`Checkbox`、`MenuItem`。新增组件前先查 Ant Design 是否已有同语义名称。
- 样式使用 CSS class + `style` prop 组合。class 名定义在 `apps/desktop/src/renderer/styles.css`，本包不包含 CSS 文件。
- 组件 props 使用具体类型，不用 `any`、`Record<string, unknown>` 或 `HTMLAttributes` 透传。

## 目录结构

```
src/
  index.ts                # barrel re-export
  avatar/index.tsx        # 每个组件一个文件夹
  badge/index.tsx
  button/index.tsx
  checkbox/index.tsx
  connector-icon/index.tsx
  logo/index.tsx
  menu-item/index.tsx
  segmented/index.tsx
  switch/index.tsx
  tag/index.tsx
```

## 新增组件流程

1. 在 `src/` 下新建 `<component-name>/index.tsx`，文件夹用 kebab-case。
2. 在 `src/index.ts` 添加 re-export。
3. 如果需要新 CSS class，在 `apps/desktop/src/renderer/styles.css` 中添加。
4. 运行 `pnpm --filter @noma/desktop typecheck` 验证。

## 注意事项

- 本包是 source-only，不需要构建步骤。消费方（Vite）直接编译 `.tsx` 源码。
- 不要添加 `build` 脚本或 `dist/` 输出。
- `ConnectorIcon` 内置了连接器颜色映射表（`CONNECTOR_COLORS`），新增内置连接器时需要同步更新。
- `Segmented` 是泛型组件（`<T extends string>`），`options` 的 `id` 类型与 `value` 联动。

## 验证

```bash
pnpm --filter @noma/desktop typecheck
```
