import { mountLanding } from "./landing.mjs";
import { mountOrder } from "./order-form.mjs";

export function mountBuy(root, state, dependencies) {
  if (state.kind !== "buy") { mountLanding(root, state, dependencies); return; }
  mountOrder(root, dependencies);
}

const script = typeof document === "undefined" ? null : document.getElementById("buy-module-script");
if (script && typeof script.startCheckout === "function") script.startCheckout(mountBuy);
