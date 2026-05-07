# @noma/ui

Noma 桌面端共享 UI 组件库。Source-only workspace 包，由消费方的 Vite 直接编译。

## 组件清单

| 组件 | 说明 | 关键 props |
|---|---|---|
| `Avatar` | 圆形头像，显示首字母 | `initials`, `color`, `size` |
| `Badge` | 状态指示点 | `kind`: `live` / `idle` / `error` / `warn` / `think` |
| `Button` | 按钮 | `kind`: `default` / `primary` / `ghost`; `size`: `sm`; `icon` |
| `Checkbox` | 复选框 | `on`, `onChange` |
| `ConnectorIcon` | 连接器图标（带品牌色和字符） | `name`（gmail / github / stocks 等）, `size` |
| `Logo` | Noma 品牌 logo | `size` |
| `MenuItem` | 侧边栏菜单项 | `icon`, `label`, `active`, `badge`, `badgeKind` |
| `Segmented` | 分段选择器 | `value`, `options`, `onChange`（泛型 `<T extends string>`） |
| `Switch` | 开关 | `on`, `onChange` |
| `Tag` | 标签 / 徽章 | `kind`: `accent` / `ok` / `warn` / `danger`; `children` |

## 使用方式

```tsx
import { Button, Tag, Badge } from "@noma/ui";
// 或按组件单独引入
import { Button } from "@noma/ui/button";
```

## 样式依赖

组件使用 CSS class（如 `.btn`、`.pill`、`.sb-item`）和 CSS custom properties（如 `var(--ink)`、`var(--line)`）。
这些样式定义在 `apps/desktop/src/renderer/styles.css`，需要由消费方加载。

## 连接器图标

`ConnectorIcon` 内置以下连接器的品牌配色：

`gmail` · `github` · `stocks` · `slack` · `lark` · `jin10` · `cal` · `rss` · `notion` · `linear` · `x`

未识别的 `name` 会回退到灰色通用图标。

## 开发

本包无构建步骤。修改后直接在桌面端 dev server 中预览：

```bash
pnpm --filter @noma/desktop dev:renderer
```

类型检查：

```bash
pnpm --filter @noma/desktop typecheck
```
