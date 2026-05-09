# UI Components

Components installed from external registries, styled for this project.

**Note:** This project uses **Base UI** (`@base-ui/react`) primitives instead of Radix UI with shadcn.

## INSTALL SOURCES

### shadcn/ui

Standard UI components (buttons, inputs, dialogs, etc.)

```bash
pnpm dlx shadcn@latest add [component]
```

Browse components: https://ui.shadcn.com/docs/components

### shadcn blocks

Pre-built page sections (hero, pricing, features, etc.)

```bash
pnpm dlx shadcn@latest add @shadcnblocks/[block-name]
```

Requires `SHADCNBLOCKS_API_KEY` env var for pro blocks.

Browse blocks: https://shadcnblocks.com

### React Bits

Animated, interactive components (text animations, backgrounds, effects)

```bash
pnpm dlx shadcn@latest add "@react-bits/[ComponentName]-TS-TW"
```

Format: `@react-bits/[ComponentName]-TS-TW` (TypeScript + Tailwind)

Browse components: https://reactbits.dev
