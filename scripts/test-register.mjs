// Registers the TypeScript-extension resolve hook, then defers to `node --test`.
// Usage: node --import ./scripts/test-register.mjs --test <test files...>
import { register } from 'node:module';

register('./test-extension-hook.mjs', import.meta.url);
