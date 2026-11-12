import { createCore } from "../../docs/js/core/index.mjs";

export function installCore(context) {
  // The old VM supplied standard language globals implicitly.
  context.Date ??= Date;
  context.console ??= console;
  context.IS = createCore(context);
  return context.IS;
}
